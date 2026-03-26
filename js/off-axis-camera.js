// js/off-axis-camera.js
// Diorama parallax — the phone screen is a window into the 3D scene.
// Off-axis projection shifts the frustum based on device tilt / head position
// making the scene look like a physical diorama you're peering into.
// The scene's own geometry (trees, ground, sky) provides the box feeling.

export class OffAxisCamera {
    constructor({ camera, controls, orbitTarget }) {
        this._camera = camera;
        this._controls = controls;
        this._orbitTarget = orbitTarget;

        this.mode = 'orbit';

        // Viewer distance (world units) — how far the "eye" is from the screen plane
        this._viewerDist = 5;

        // Eye offset normalized -1 to 1
        this._eyeX = 0;
        this._eyeY = 0;

        // Smoothed
        this._smoothX = 0;
        this._smoothY = 0;
        this._smoothing = 0.08;

        // Transition
        this._transitionT = 0;
        this._transitionSpeed = 2.0;

        // Store initial camera state
        this._basePos = camera.position.clone();
        this._baseFov = camera.fov;

        // Window half-dimensions (computed from camera FOV to match viewport exactly)
        this._halfW = 0;
        this._halfH = 0;

        // Tracking handlers
        this._orientHandler = null;
        this._mouseHandler = null;
        this._baseGamma = null;
        this._baseBeta = null;
    }

    setMode(mode) {
        if (mode === this.mode) return;

        if (mode === 'offaxis') {
            this._basePos.copy(this._camera.position);
            this._controls.enabled = false;
            this._camera.projectionMatrixAutoUpdate = false;

            // Compute window dimensions from camera FOV so frustum matches viewport
            const fovRad = this._camera.fov * Math.PI / 180;
            const aspect = window.innerWidth / window.innerHeight;
            this._halfH = this._viewerDist * Math.tan(fovRad / 2);
            this._halfW = this._halfH * aspect;

            this._startTracking();
            this.mode = 'offaxis';
            console.log('[OffAxisCamera] diorama ON, window:', (this._halfW * 2).toFixed(2), 'x', (this._halfH * 2).toFixed(2));
        } else {
            this._controls.enabled = true;
            this._camera.projectionMatrixAutoUpdate = true;
            this._camera.updateProjectionMatrix();
            this._stopTracking();
            this._camera.position.copy(this._basePos);
            this._camera.lookAt(this._orbitTarget);
            this.mode = 'orbit';
        }
    }

    _startTracking() {
        const startGyro = () => {
            this._baseGamma = null;
            this._baseBeta = null;
            this._orientHandler = (e) => {
                if (e.gamma == null || e.beta == null) return;
                if (this._baseGamma === null) {
                    this._baseGamma = e.gamma;
                    this._baseBeta = e.beta;
                }
                // gamma = left/right tilt, beta = front/back tilt
                // Tilt phone right -> reveal left side -> shift eye right
                // Tilt phone top away -> reveal bottom -> shift eye down
                this._eyeX = Math.max(-1, Math.min(1, (e.gamma - this._baseGamma) / 20));
                this._eyeY = Math.max(-1, Math.min(1, (e.beta - this._baseBeta) / 20));
            };
            window.addEventListener('deviceorientation', this._orientHandler);
            console.log('[OffAxisCamera] gyroscope started');
        };

        // iOS 13+ needs permission from user gesture
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            const reqOnTap = () => {
                DeviceOrientationEvent.requestPermission().then(s => {
                    if (s === 'granted') startGyro();
                }).catch(() => {});
                document.removeEventListener('touchstart', reqOnTap);
                document.removeEventListener('click', reqOnTap);
            };
            document.addEventListener('touchstart', reqOnTap, { once: true });
            document.addEventListener('click', reqOnTap, { once: true });
        } else if (window.DeviceOrientationEvent) {
            startGyro();
        }

        // Mouse on desktop
        this._mouseHandler = (e) => {
            this._eyeX = (e.clientX / window.innerWidth - 0.5) * 2;
            this._eyeY = (e.clientY / window.innerHeight - 0.5) * 2;
        };
        window.addEventListener('mousemove', this._mouseHandler);
    }

    _stopTracking() {
        if (this._orientHandler) {
            window.removeEventListener('deviceorientation', this._orientHandler);
            this._orientHandler = null;
        }
        if (this._mouseHandler) {
            window.removeEventListener('mousemove', this._mouseHandler);
            this._mouseHandler = null;
        }
    }

    setEyeFromFaceTracker(headPose) {
        if (!headPose) return;
        this._eyeX = headPose.x;
        this._eyeY = headPose.y;
    }

    update(headPose, delta) {
        if (this._faceActive && headPose && (headPose.x !== 0 || headPose.y !== 0)) {
            this.setEyeFromFaceTracker(headPose);
        }

        // Transition
        const targetT = this.mode === 'offaxis' ? 1 : 0;
        if (this._transitionT < targetT) {
            this._transitionT = Math.min(this._transitionT + this._transitionSpeed * delta, 1);
        } else if (this._transitionT > targetT) {
            this._transitionT = Math.max(this._transitionT - this._transitionSpeed * delta, 0);
        }
        if (this._transitionT <= 0) return;

        // Smooth
        this._smoothX += (this._eyeX - this._smoothX) * this._smoothing;
        this._smoothY += (this._eyeY - this._smoothY) * this._smoothing;

        const t = this._transitionT;

        // Eye offset in world units
        const eyeX = this._smoothX * this._halfW * 0.5;
        const eyeY = this._smoothY * this._halfH * 0.5;

        // === OFF-AXIS PROJECTION ===
        // Screen plane is at the orbit target. Viewer is at _viewerDist from it.
        // Asymmetric frustum: shift the window edges by the eye offset.
        const near = this._camera.near;
        const far = this._camera.far;
        const d = this._viewerDist;
        const nOverD = near / d;

        const left   = (-this._halfW - eyeX) * nOverD;
        const right  = ( this._halfW - eyeX) * nOverD;
        const top    = ( this._halfH - eyeY) * nOverD;
        const bottom = (-this._halfH - eyeY) * nOverD;

        // Three.js: makePerspective(left, right, top, bottom, near, far)
        this._camera.projectionMatrix.makePerspective(left, right, top, bottom, near, far);
        this._camera.projectionMatrixInverse.copy(this._camera.projectionMatrix).invert();

        // Move camera to match eye position (creates parallax)
        const base = this._basePos;
        this._camera.position.set(
            base.x + eyeX * t,
            base.y + eyeY * t,
            base.z
        );
        this._camera.lookAt(this._orbitTarget);
    }

    set faceActive(v) { this._faceActive = v; }
}
