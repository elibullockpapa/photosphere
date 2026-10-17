import * as THREE from "three";
import { settings, forceForFullZoom, ZOOM_DEAD_ZONE } from "./settings.js";

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Draws the photo on the inside of a sphere and points the camera where you look. */
export class Viewer {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 2000);

    const geometry = new THREE.SphereGeometry(500, 128, 64);
    geometry.scale(-1, 1, 1); // seen from inside, so flip it back
    this.material = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.sphere = new THREE.Mesh(geometry, this.material);
    this.sphere.rotation.y = -Math.PI / 2; // the middle of the photo faces forward
    this.scene.add(this.sphere);

    this.sensors = null;
    this.frozen = false;
    this.dragYaw = 0;
    this.dragPitch = 0;
    this.manualZoom = 1;
    this.pressureZoom = 0;
    this.zoom = 1;
    this.headingZero = 0;
    this.needsRecenter = true;
    this.held = { yaw: 0, pitch: 0, roll: 0 };
    this.wasHoldingYaw = false;
    this.shown = new THREE.Quaternion();
    this.lastFrame = performance.now();

    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  resize() {
    const canvas = this.renderer.domElement;
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    this.camera.updateProjectionMatrix();
  }

  /** Loads a photo; resolves with its pixel size. */
  async show(url) {
    this.loadingUrl = url;
    const blob = await (await fetch(url)).blob();
    const probe = await createImageBitmap(blob);
    const max = this.renderer.capabilities.maxTextureSize;
    const scale = Math.min(1, max / probe.width, max / probe.height);
    const size = { width: probe.width, height: probe.height };
    probe.close();
    const bitmap = await createImageBitmap(blob, {
      imageOrientation: "flipY",
      ...(scale < 1 ? { resizeWidth: Math.floor(size.width * scale), resizeHeight: Math.floor(size.height * scale), resizeQuality: "high" } : {}),
    });
    if (this.loadingUrl !== url) return size;

    const texture = new THREE.Texture(bitmap);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    texture.needsUpdate = true;
    const old = this.material.map;
    this.material.map = texture;
    this.material.color.set(0xffffff);
    this.material.needsUpdate = true;
    if (old) {
      old.image?.close?.();
      old.dispose();
    }
    return size;
  }

  recenter() {
    this.needsRecenter = true;
    this.dragYaw = 0;
    this.dragPitch = 0;
    this.manualZoom = 1;
  }

  drag(dx, dy) {
    const k = (0.004 * settings.dragSpeed * (settings.invertDrag ? -1 : 1)) / this.zoom;
    this.dragYaw += dx * k;
    this.dragPitch = clamp(this.dragPitch + dy * k, -1.5, 1.5);
  }

  zoomBy(factor) {
    this.manualZoom = clamp(this.manualZoom * factor, 1, 8);
  }

  get motionActive() {
    return !!(settings.motion && this.sensors && this.sensors.motion && this.sensors.ready);
  }

  /** Which way the laptop screen faces: yaw (heading), pitch (up/down), roll (sideways lean), in radians. */
  screenAngles() {
    const s = this.sensors;
    const q = new THREE.Quaternion(s.q[0], s.q[1], s.q[2], s.q[3]); // laptop base, body to world (z up)
    // The sensor sits in the base; tilt its forward axis back by the lid angle to look out of the screen.
    const tilt = settings.followScreenAngle && s.lidSensor ? (s.lid - 90) * DEG : 0;
    const up = new THREE.Vector3(0, Math.sin(tilt), Math.cos(tilt)).applyQuaternion(q);
    const forward = new THREE.Vector3(0, Math.cos(tilt), -Math.sin(tilt)).applyQuaternion(q);
    // World z-up to three.js y-up: (x, y, z) -> (x, z, -y).
    const f = new THREE.Vector3(forward.x, forward.z, -forward.y);
    const u = new THREE.Vector3(up.x, up.z, -up.y);

    const yaw = Math.atan2(-f.x, -f.z);
    const pitch = Math.asin(clamp(f.y, -1, 1));
    const level = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
    const levelUp = new THREE.Vector3(0, 1, 0).applyQuaternion(level);
    const levelRight = new THREE.Vector3(1, 0, 0).applyQuaternion(level);
    const roll = Math.atan2(-u.dot(levelRight), u.dot(levelUp));
    return { yaw, pitch, roll };
  }

  frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    const lockTurn = settings.lockTurn || this.frozen;
    if (this.motionActive) {
      const angles = this.screenAngles();
      if (this.needsRecenter) {
        this.headingZero = angles.yaw;
        this.needsRecenter = false;
      }
      if (lockTurn) {
        this.wasHoldingYaw = true;
      } else {
        // Unlocking picks up where the view was instead of snapping to wherever the laptop points now.
        if (this.wasHoldingYaw) this.headingZero += angles.yaw - this.held.yaw;
        this.wasHoldingYaw = false;
        this.held.yaw = angles.yaw;
      }
      if (!this.frozen) {
        this.held.pitch = angles.pitch;
        this.held.roll = angles.roll;
      }
    } else {
      this.held = { yaw: 0, pitch: 0, roll: 0 };
      this.headingZero = 0;
      this.needsRecenter = false;
    }

    const yaw = this.held.yaw - this.headingZero + this.dragYaw;
    const pitch = clamp((settings.lockTilt ? 0 : this.held.pitch) + this.dragPitch, -1.55, 1.55);
    const roll = settings.level ? 0 : this.held.roll;
    const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
    const keep = settings.smoothing * 0.92;
    this.shown.slerp(target, 1 - Math.pow(keep, dt * 120));
    this.camera.quaternion.copy(this.shown);

    // Zoom: press harder on a Mac trackpad, scroll or pinch everywhere.
    const force = this.sensors ? this.sensors.force : 0;
    const full = forceForFullZoom(settings.zoomSensitivity);
    const pressed = settings.pressureZoom ? clamp((force - ZOOM_DEAD_ZONE) / (full - ZOOM_DEAD_ZONE), 0, 1) : 0;
    this.pressureZoom += (pressed - this.pressureZoom) * (1 - Math.pow(0.8, dt * 120));
    const eased = this.pressureZoom * this.pressureZoom * (3 - 2 * this.pressureZoom);
    this.zoom = Math.min(12, (1 + (settings.maxZoom - 1) * eased) * this.manualZoom);
    this.camera.fov = (2 * Math.atan(Math.tan((settings.fieldOfView * DEG) / 2) / this.zoom)) / DEG;
    this.camera.updateProjectionMatrix();

    this.renderer.render(this.scene, this.camera);
  }
}
