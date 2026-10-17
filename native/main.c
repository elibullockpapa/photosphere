// photosphere-sensors: streams the Mac's motion sensors and trackpad force to the Electron app.
// Each line: qx qy qz qw lidDegrees trackpadForce flags
// flags: bit 0 = orientation ready, bit 1 = motion sensor found, bit 2 = lid angle found.
// Exits when stdin closes, so it never outlives the app.

#include "sensors.h"
#include <CoreFoundation/CoreFoundation.h>
#include <dispatch/dispatch.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static void emit(CFRunLoopTimerRef timer, void *info) {
    float q[4] = {0, 0, 0, 1};
    bool ready = sensors_orientation(q);
    int flags = (ready ? 1 : 0) | (sensors_has_motion() ? 2 : 0) | (sensors_has_lid_angle() ? 4 : 0);
    printf("%.5f %.5f %.5f %.5f %.0f %.1f %d\n", q[0], q[1], q[2], q[3], sensors_lid_degrees(), sensors_trackpad_force(), flags);
    fflush(stdout);
}

int main(void) {
    sensors_start();

    dispatch_source_t input = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(input, ^{
        char buffer[256];
        if (read(STDIN_FILENO, buffer, sizeof buffer) <= 0) exit(0);
    });
    dispatch_resume(input);

    CFRunLoopTimerRef timer = CFRunLoopTimerCreate(NULL, CFAbsoluteTimeGetCurrent(), 1.0 / 120, 0, 0, emit, NULL);
    CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopCommonModes);
    CFRunLoopRun();
    return 0;
}
