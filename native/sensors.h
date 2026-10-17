#pragma once
#include <stdbool.h>

// Starts the motion sensors (accelerometer, gyroscope and lid angle behind Apple silicon's
// always-on processor) and the trackpad force reading. Safe to call more than once.
void sensors_start(void);

// The laptop base's orientation as a body-to-world quaternion (x, y, z, w). World z is up.
// Body axes: x to the right of the keyboard, y toward the hinge, z up out of the keyboard.
bool sensors_orientation(float quaternion[4]);

bool sensors_has_motion(void);
bool sensors_has_lid_angle(void);
float sensors_lid_degrees(void);

// Total force on the trackpad (0 when nothing presses it).
float sensors_trackpad_force(void);
