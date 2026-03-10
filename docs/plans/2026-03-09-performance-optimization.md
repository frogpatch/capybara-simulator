# Performance Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move all per-frame CPU work to the GPU so desktop is smooth and mobile is playable, while establishing an agent-ready architecture for future features.

**Architecture:** Quality presets (HIGH/LOW) selected at startup via device detection. Flowers become a single InstancedMesh with wind in a vertex shader. Rain becomes a GPU ShaderMaterial with zero CPU updates per frame. Everything animated lives in GLSL.

**Tech Stack:** Three.js 0.160, vanilla JS, single index.html, no build step.

---

### Task 1: Branch + mobile detection + renderer cleanup

**Files:**
- Modify: `index.html` (constructor)

**Step 1:** Add `_isMobile` flag before renderer creation, remove `preserveDrawingBuffer`, make antialias and pixelRatio conditional.

```js
this._isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
this.renderer = new THREE.WebGLRenderer({
    antialias: !this._isMobile,
    powerPreference: 'high-performance',
});
this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this._isMobile ? 1.5 : 2));
this.renderer.shadowMap.type = this._isMobile ? THREE.BasicShadowMap : THREE.PCFShadowMap;
```

**Step 2:** Commit — `perf: mobile detection, remove preserveDrawingBuffer`

---

### Task 2: Shadow map + frustum

**Files:**
- Modify: `index.html` (setupLighting)

**Step 1:** Reduce shadow map from 2048 to 1024/512 and tighten frustum from ±60 to ±20.

```js
this._sun.shadow.mapSize.set(this._isMobile ? 512 : 1024, this._isMobile ? 512 : 1024);
this._sun.shadow.camera.left   = -20;
this._sun.shadow.camera.right  =  20;
this._sun.shadow.camera.top    =  20;
this._sun.shadow.camera.bottom = -20;
```

**Step 2:** Commit — `perf: tighten shadow map and frustum`

---

### Task 3: Terrain simplification

**Files:**
- Modify: `index.html` (buildScene)

**Step 1:** Reduce terrain from 140×120 segments (17K verts) to 50×40 (2K verts). Pond circles 48 → 32 segments. Object placement uses `getTerrainY()` formula — not mesh verts — so nothing floats.

```js
const groundGeo = new THREE.PlaneGeometry(140, 120, 50, 40);
// pond:
const waterGeo = new THREE.CircleGeometry(8, 32);
const sandGeo  = new THREE.CircleGeometry(10, 32);
```

**Step 2:** Commit — `perf: reduce terrain and pond geometry`

---

### Task 4: InstancedMesh flowers + GPU wind shader

**Files:**
- Modify: `index.html` (buildScene, new `_buildFlowerInstances` method, animate)

**Step 1:** Replace the 500-clone flower loop with a call to `_buildFlowerInstances()`. Remove `recolorFlower` method (dead code). Remove the CPU wind loop from `animate()`.

**Step 2:** Add `_buildFlowerInstances()`:

```js
_buildFlowerInstances() {
    let srcMesh = null;
    this.models['flower'].traverse(c => {
        if (c.isMesh && c.material && c.material.name === 'Flowers' && !srcMesh) srcMesh = c;
    });
    if (!srcMesh) return;

    const geo = srcMesh.geometry.clone();
    const localMat = new THREE.Matrix4().compose(srcMesh.position, srcMesh.quaternion, srcMesh.scale);
    geo.applyMatrix4(localMat);

    const mat = srcMesh.material.clone();
    mat.map = null;
    mat.color.set(0xc4a0e0);
    mat.userData.uniforms = { windTime: { value: 0 } };
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.windTime = mat.userData.uniforms.windTime;
        shader.vertexShader = `
            attribute float aWindPhase;
            attribute float aWindStrength;
            uniform float windTime;
        ` + shader.vertexShader.replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            float wX = sin(windTime * 1.5 + aWindPhase) * aWindStrength;
            float wZ = sin(windTime * 1.2 + aWindPhase * 0.7) * aWindStrength * 0.6;
            transformed.x += transformed.y * wX;
            transformed.z += transformed.y * wZ;`
        );
    };

    const COUNT = 400;
    const mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;

    const windPhases    = new Float32Array(COUNT);
    const windStrengths = new Float32Array(COUNT);
    const dummy = new THREE.Object3D();
    let idx = 0;
    const clusters = [[0,0],[-4,2],[5,-1],[-2,-3],[3,4],[-6,-2],[7,2],[-3,5],[1,-5],[6,-4]];

    for (let attempt = 0; attempt < 1500 && idx < COUNT; attempt++) {
        const c = clusters[Math.floor(Math.random() * clusters.length)];
        const x = c[0] + (Math.random() - 0.5) * 8;
        const z = c[1] + (Math.random() - 0.5) * 5;
        if (z < -7 || z > 8) continue;
        if (Math.sqrt(x*x + z*z) < 1.2) continue;
        const scale = 0.30 + Math.random() * 0.2;
        dummy.position.set(x, 0, z);
        dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(idx, dummy.matrix);
        windPhases[idx]    = Math.random() * Math.PI * 2;
        windStrengths[idx] = 0.06 + Math.random() * 0.05;
        idx++;
    }
    mesh.count = idx;
    mesh.instanceMatrix.needsUpdate = true;
    geo.setAttribute('aWindPhase',    new THREE.InstancedBufferAttribute(windPhases.slice(0, idx), 1));
    geo.setAttribute('aWindStrength', new THREE.InstancedBufferAttribute(windStrengths.slice(0, idx), 1));
    this.scene.add(mesh);
    this._instancedFlowers = mesh;
}
```

**Step 3:** In `animate()` replace CPU wind loop:
```js
// Remove:
for (const flower of this.flowerInstances) { ... }
// Add:
if (this._instancedFlowers) this._instancedFlowers.material.userData.uniforms.windTime.value = time;
```

**Step 4:** Commit — `perf: instanced flowers with GPU wind shader`

---

### Task 5: GPU rain shader

**Files:**
- Modify: `index.html` (setupWeather, _updateWeather, animate)

**Step 1:** Replace CPU rain particles with a `THREE.ShaderMaterial` on the `THREE.Points`. Zero CPU updates per frame — only `time` and `camPos` uniforms updated.

**Step 2:** Rewrite `setupWeather` rain section (keep audio, weather color baseline, and toggle button logic intact — only replace the geometry/material creation).

Vertex shader computes each drop's Y from `mod(seedY * 26.0 - time * speed, 27.0) - 2.0` — GPU falling loop. XZ positions follow camera via `camPos` uniform.

**Step 3:** Change `_updateWeather(delta)` → `_updateWeather(delta, time)`. Replace the CPU position loop with:
```js
if (this._rainUniforms) {
    this._rainUniforms.time.value   = time;
    this._rainUniforms.camPos.value.copy(this.camera.position);
    this._rainUniforms.opacity.value = t * 0.8;
}
```

**Step 4:** In `animate()` pass `time`:
```js
if (this._rainParticles) this._updateWeather(delta, time);
```

**Step 5:** Commit — `perf: GPU rain shader, zero CPU particle updates`

---

### Task 6: Push + deploy to dev

```bash
git remote set-url origin https://summer-plays:TOKEN@github.com/summer-plays/capybara-simulator.git
git push -u origin feature/ac-optimize
git checkout dev
git merge feature/ac-optimize
git push origin dev
```

Railway auto-deploys dev branch → `https://web-development-96f3.up.railway.app`
