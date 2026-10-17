#include "sensors.h"
#include <IOKit/IOKitLib.h>
#include <IOKit/hid/IOHIDDevice.h>
#include <CoreFoundation/CoreFoundation.h>
#include <mach/mach_time.h>
#include <os/lock.h>
#include <simd/simd.h>
#include <stdatomic.h>
#include <string.h>
#include <math.h>

#pragma mark - Trackpad force (private MultitouchSupport framework)

typedef void *MTDeviceRef;
typedef struct { int frame, reserved1; float reserved2, reserved3, normalizedX, normalizedY, mmX, mmY, totalForce; } ForceCentroid;
typedef void (*MTForceCentroidCallback)(MTDeviceRef, ForceCentroid *);
extern MTDeviceRef MTDeviceCreateDefault(void);
extern void MTRegisterForceCentroidCallback(MTDeviceRef, MTForceCentroidCallback);
extern void MTDeviceStart(MTDeviceRef, int);

static _Atomic float trackpadForce;
static void onForceCentroid(MTDeviceRef device, ForceCentroid *centroid) { atomic_store(&trackpadForce, fmaxf(0, centroid->totalForce)); }

float sensors_trackpad_force(void) { return atomic_load(&trackpadForce); }

#pragma mark - Motion

static double now(void) {
    static mach_timebase_info_data_t timebase;
    if (!timebase.denom) mach_timebase_info(&timebase);
    return (double)mach_absolute_time() * timebase.numer / timebase.denom / 1e9;
}

static os_unfair_lock lock = OS_UNFAIR_LOCK_INIT;
static simd_quatf bodyToWorld = {{0, 0, 0, 1}};
static bool orientationReady;
static float gyroDegrees[3], gyroBias[3], biasSum[3], integralError[3];
static int biasSamples;
static double firstGyroAt, lastAccelAt;
static _Atomic float lidDegrees = 90;
static atomic_bool hasLidAngle, hasMotion;
static uint8_t accelReport[64], gyroReport[64], lidReport[64];

static void readXYZ(const uint8_t *report, float out[3]) {
    for (int i = 0; i < 3; i++) {
        int32_t value;
        memcpy(&value, report + 6 + 4 * i, 4);
        out[i] = value / 65536.0f;
    }
}

// Reports are 22 bytes with x, y, z as 16.16 fixed point at offsets 6, 10, 14 (g, or deg/s for the gyro).
static void onGyroReport(void *context, IOReturn result, void *sender, IOHIDReportType type, uint32_t reportID, uint8_t *report, CFIndex length) {
    if (length < 18) return;
    float g[3];
    readXYZ(report, g);
    os_unfair_lock_lock(&lock);
    memcpy(gyroDegrees, g, sizeof g);

    // There is no compass, so gyro bias is all that makes the view creep sideways. Learn it while
    // the laptop is still: averaged over the first second, then trimmed whenever it rests.
    float magnitude = sqrtf(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
    if (firstGyroAt == 0) firstGyroAt = now();
    if (now() - firstGyroAt < 1.0) {
        if (magnitude < 3) {
            for (int i = 0; i < 3; i++) biasSum[i] += g[i];
            biasSamples++;
            for (int i = 0; i < 3; i++) gyroBias[i] = biasSum[i] / biasSamples;
        }
    } else {
        float dx = g[0] - gyroBias[0], dy = g[1] - gyroBias[1], dz = g[2] - gyroBias[2];
        if (sqrtf(dx * dx + dy * dy + dz * dz) < 0.6f)
            for (int i = 0; i < 3; i++) gyroBias[i] += (g[i] - gyroBias[i]) * 0.003f;
    }
    os_unfair_lock_unlock(&lock);
}

// Mahony filter: integrate the gyro and pull it toward the accelerometer's idea of which way is up.
// The accelerometer reads the direction of gravity (flat on a desk = 0, 0, -1).
static void onAccelReport(void *context, IOReturn result, void *sender, IOHIDReportType type, uint32_t reportID, uint8_t *report, CFIndex length) {
    if (length < 18) return;
    float a[3];
    readXYZ(report, a);
    float norm = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    if (norm < 0.3f) return;
    simd_float3 down = simd_make_float3(a[0], a[1], a[2]) / norm;

    double t = now();
    float dt = lastAccelAt > 0 ? (float)fmin(t - lastAccelAt, 0.05) : 0.005f;
    lastAccelAt = t;

    os_unfair_lock_lock(&lock);
    if (!orientationReady) {
        bodyToWorld = simd_quaternion(-down, simd_make_float3(0, 0, 1));
        orientationReady = true;
    } else {
        simd_float3 estimatedUp = simd_act(simd_inverse(bodyToWorld), simd_make_float3(0, 0, 1));
        simd_float3 error = simd_cross(-down, estimatedUp);
        const float kp = 1.0f, ki = 0.05f;
        float w[3];
        for (int i = 0; i < 3; i++) {
            integralError[i] += ki * error[i] * dt;
            w[i] = (gyroDegrees[i] - gyroBias[i]) * (float)M_PI / 180 + kp * error[i] + integralError[i];
        }
        simd_quatf q = bodyToWorld;
        q.vector += simd_mul(q, simd_quaternion(w[0], w[1], w[2], 0.0f)).vector * 0.5f * dt;
        bodyToWorld = simd_normalize(q);
    }
    os_unfair_lock_unlock(&lock);
    atomic_store(&hasMotion, true);
}

static void onLidReport(void *context, IOReturn result, void *sender, IOHIDReportType type, uint32_t reportID, uint8_t *report, CFIndex length) {
    if (length < 3 || report[0] != 1) return;
    int angle = (report[1] | report[2] << 8) & 0x1FF;
    if (angle < 20 || angle > 200) return;
    atomic_store(&lidDegrees, (float)angle);
    atomic_store(&hasLidAngle, true);
}

static void setSensorProperty(io_service_t service, CFStringRef key, int value) {
    CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &value);
    IORegistryEntrySetCFProperty(service, key, number);
    CFRelease(number);
}

static int intProperty(io_service_t service, CFStringRef key) {
    int value = 0;
    CFNumberRef number = IORegistryEntryCreateCFProperty(service, key, NULL, 0);
    if (number) { CFNumberGetValue(number, kCFNumberIntType, &value); CFRelease(number); }
    return value;
}

static void startMotion(void) {
    io_iterator_t devices;
    if (IOServiceGetMatchingServices(MACH_PORT_NULL, IOServiceMatching("AppleSPUHIDDevice"), &devices) != KERN_SUCCESS) return;
    io_service_t device;
    while ((device = IOIteratorNext(devices))) {
        int page = intProperty(device, CFSTR("PrimaryUsagePage")), usage = intProperty(device, CFSTR("PrimaryUsage"));
        IOHIDReportCallback callback = NULL;
        uint8_t *buffer = NULL;
        if (page == 0xFF00 && usage == 3) { callback = onAccelReport; buffer = accelReport; }
        else if (page == 0xFF00 && usage == 9) { callback = onGyroReport; buffer = gyroReport; }
        else if (page == 0x20 && usage == 0x8A) { callback = onLidReport; buffer = lidReport; }
        if (!callback) { IOObjectRelease(device); continue; }

        // The sensors idle until asked to report; the driver drops back to idle when we quit.
        io_iterator_t children;
        IORegistryEntryCreateIterator(device, kIOServicePlane, kIORegistryIterateRecursively, &children);
        io_service_t child;
        while ((child = IOIteratorNext(children))) {
            io_name_t className;
            IOObjectGetClass(child, className);
            if (!strcmp(className, "AppleSPUHIDDriver")) {
                setSensorProperty(child, CFSTR("SensorPropertyReportingState"), 1);
                setSensorProperty(child, CFSTR("SensorPropertyPowerState"), 1);
                setSensorProperty(child, CFSTR("ReportInterval"), 5000);
            }
            IOObjectRelease(child);
        }
        IOObjectRelease(children);

        IOHIDDeviceRef hid = IOHIDDeviceCreate(NULL, device);
        if (hid && IOHIDDeviceOpen(hid, 0) == kIOReturnSuccess) {
            IOHIDDeviceRegisterInputReportCallback(hid, buffer, 64, callback, NULL);
            IOHIDDeviceScheduleWithRunLoop(hid, CFRunLoopGetMain(), kCFRunLoopDefaultMode);
        }
        IOObjectRelease(device);
    }
    IOObjectRelease(devices);
}

void sensors_start(void) {
    static bool started;
    if (started) return;
    started = true;
    MTDeviceRef device = MTDeviceCreateDefault();
    if (device) {
        MTRegisterForceCentroidCallback(device, onForceCentroid);
        MTDeviceStart(device, 0);
    }
    startMotion();
}

bool sensors_orientation(float quaternion[4]) {
    os_unfair_lock_lock(&lock);
    bool ready = orientationReady && now() - firstGyroAt > 1.0;
    simd_float4 v = bodyToWorld.vector;
    os_unfair_lock_unlock(&lock);
    if (!ready) return false;
    quaternion[0] = v.x; quaternion[1] = v.y; quaternion[2] = v.z; quaternion[3] = v.w;
    return true;
}

bool sensors_has_motion(void) { return atomic_load(&hasMotion); }
bool sensors_has_lid_angle(void) { return atomic_load(&hasLidAngle); }
float sensors_lid_degrees(void) { return atomic_load(&lidDegrees); }
