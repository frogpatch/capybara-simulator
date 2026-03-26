// js/face-tracker.js
// Client-side face tracking via MediaPipe Face Mesh.
// All processing local — no data leaves the device.

export class FaceTracker {
    constructor() {
        this.isActive = false;
        this.isPresent = false;
        this.timeSinceLeft = 0;
        this.headPose = { x: 0, y: 0, z: 0, tiltX: 0, tiltY: 0 };

        this._video = null;
        this._faceMesh = null;
        this._lastPresentTime = 0;
        this._smoothing = 0.3;
        this._raw = { x: 0, y: 0, z: 0, tiltX: 0, tiltY: 0 };
        this._animFrame = null;
    }

    async start() {
        if (this.isActive) return;
        try {
            // Load MediaPipe via ES module dynamic import
            const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/+esm');

            const filesetResolver = await vision.FilesetResolver.forVisionTasks(
                'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm'
            );

            const faceMesh = await vision.FaceLandmarker.createFromOptions(filesetResolver, {
                baseOptions: {
                    modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
                    delegate: 'GPU',
                },
                runningMode: 'VIDEO',
                numFaces: 1,
                outputFaceBlendshapes: false,
                outputFacialTransformationMatrixes: true,
            });
            this._faceMesh = faceMesh;

            this._video = document.createElement('video');
            this._video.setAttribute('playsinline', '');
            this._video.style.display = 'none';
            document.body.appendChild(this._video);

            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
            });
            this._video.srcObject = stream;
            await this._video.play();

            this.isActive = true;
            this._lastPresentTime = performance.now() / 1000;
            this._tick();
            console.log('[FaceTracker] started');
        } catch (e) {
            console.warn('[FaceTracker] failed to start:', e.message || e);
            this.isActive = false;
        }
    }

    stop() {
        this.isActive = false;
        if (this._animFrame) cancelAnimationFrame(this._animFrame);
        if (this._video) {
            const tracks = this._video.srcObject?.getTracks();
            if (tracks) tracks.forEach(t => t.stop());
            this._video.remove();
            this._video = null;
        }
        this.isPresent = false;
        console.log('[FaceTracker] stopped');
    }

    _tick() {
        if (!this.isActive) return;
        this._animFrame = requestAnimationFrame(() => this._tick());
        if (!this._video || this._video.readyState < 2 || !this._faceMesh) return;

        const now = performance.now();
        const results = this._faceMesh.detectForVideo(this._video, now);

        if (results.facialTransformationMatrixes && results.facialTransformationMatrixes.length > 0) {
            this.isPresent = true;
            this._lastPresentTime = now / 1000;
            this.timeSinceLeft = 0;

            const mat = results.facialTransformationMatrixes[0].data;
            const tx = mat[12];
            const ty = mat[13];
            const tz = mat[14];
            const tiltX = Math.asin(-mat[6]);
            const tiltY = Math.atan2(mat[2], mat[10]);

            this._raw.x = Math.max(-1, Math.min(1, tx / 15));
            this._raw.y = Math.max(-1, Math.min(1, ty / 15));
            this._raw.z = Math.max(-1, Math.min(1, (tz + 40) / 30));
            this._raw.tiltX = Math.max(-1, Math.min(1, tiltX / 0.5));
            this._raw.tiltY = Math.max(-1, Math.min(1, tiltY / 0.5));

            const s = this._smoothing;
            this.headPose.x += (this._raw.x - this.headPose.x) * s;
            this.headPose.y += (this._raw.y - this.headPose.y) * s;
            this.headPose.z += (this._raw.z - this.headPose.z) * s;
            this.headPose.tiltX += (this._raw.tiltX - this.headPose.tiltX) * s;
            this.headPose.tiltY += (this._raw.tiltY - this.headPose.tiltY) * s;
        } else {
            this.isPresent = false;
            this.timeSinceLeft = (now / 1000) - this._lastPresentTime;
        }
    }
}
