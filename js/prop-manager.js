// js/prop-manager.js
// Loads, normalizes, and manages props (sunglasses, magazine, etc.)
// Two attachment modes: bone-attached (follows skeleton) and scene-placed.

export class PropManager {
    constructor({ scene, loader }) {
        this._scene = scene;
        this._loader = loader;

        this._defs = {
            sunglasses:       { path: 'models/props/sunglasses.glb', type: 'bone', bone: 'Head', offsetUp: 0.15, offsetFwd: 0.2, offsetSide: 0, rotX: 0, rotY: 0, rotZ: 0, scale: 0.4 },
            magazine:         { path: 'models/props/magazine.glb', type: 'bone', bone: 'RightHand', offsetUp: 0, offsetFwd: 0.1, offsetSide: 0, rotX: 0, rotY: 0, rotZ: 0, scale: 0.5 },
            'coffee-cup':     { path: 'models/props/coffee-cup.glb', type: 'bone', bone: 'LeftHand', offsetUp: -0.15, offsetFwd: 0.05, offsetSide: -0.05, rotX: 0, rotY: 0, rotZ: 65 * Math.PI / 180, scale: 0.7 },
            'stop-sign':      { path: 'models/props/stop-sign.glb', type: 'bone', bone: 'RightHand', offsetUp: 0, offsetFwd: 0.05, offsetSide: 0, rotX: Math.PI / 2, rotY: 0, rotZ: 0, scale: 0.3 },
            'rubber-duck':    { path: 'models/props/rubber-duck.glb', type: 'scene', pos: [3, 0.05, -4], scale: 0.4 },
            briefcase:        { path: 'models/props/briefcase.glb', type: 'scene', pos: [0, 0, 0], scale: 0.3 },
            'beach-umbrella': { path: 'models/props/beach-umbrella.glb', type: 'scene', pos: [0, 2.5, 0.5], scale: 0.5 },
            boombox:          { path: 'models/props/boombox.glb', type: 'scene', pos: [1.2, 0, 1.5], scale: 1.75 },
        };

        this._models = {};
        this._active = {};
        this._bones = {};
        this._tempVec = null;
        this._tempQuat = null;
        this._correctionQuat = null;
        this._Vector3 = null;
        this._Quaternion = null;
    }

    setBones(boneMap) {
        this._bones = boneMap;
    }

    setMathUtils(Vector3, Quaternion, Box3) {
        this._tempVec = new Vector3();
        this._tempQuat = new Quaternion();
        this._Vector3 = Vector3;
        this._Quaternion = Quaternion;
        this._Box3 = Box3;
        // Same correction as hat system: bone local +Y = world +Z, so rotate -90 deg X
        this._correctionQuat = new Quaternion().setFromAxisAngle(
            new Vector3(1, 0, 0), -Math.PI / 2
        );
    }

    get totalCount() { return Object.keys(this._defs).length; }

    async loadAll(onProgress) {
        for (const [name, def] of Object.entries(this._defs)) {
            try {
                const gltf = await new Promise((resolve, reject) => {
                    this._loader.load(def.path, resolve, undefined, reject);
                });
                const model = gltf.scene;
                model.scale.setScalar(def.scale || 1);

                // Normalize pivot: for bone-attached props, shift model so
                // bottom of bounding box is at local origin (pole base = hand)
                if (def.type === 'bone' && this._Box3) {
                    const bbox = new this._Box3().setFromObject(model);
                    const center = new this._Vector3();
                    bbox.getCenter(center);
                    model.position.x -= center.x;
                    model.position.z -= center.z;
                    model.position.y -= bbox.min.y;
                }

                // Fix materials (same pattern as hat/capybara material fix)
                model.traverse(c => {
                    if (c.isMesh && c.material) {
                        c.material = c.material.clone();
                        if (c.material.emissiveMap && !c.material.map) {
                            c.material.map = c.material.emissiveMap;
                        }
                        if (c.material.emissive) c.material.emissive.set(0, 0, 0);
                        c.material.emissiveIntensity = 0;
                        c.material.emissiveMap = null;
                        // If no texture at all, set a neutral color instead of default pink
                        if (!c.material.map && c.material.color) {
                            const hex = c.material.color.getHex();
                            if (hex === 0xffffff || hex === 0xff00ff || hex === 0x000000) {
                                c.material.color.set(0x808080);
                            }
                        }
                        c.material.needsUpdate = true;
                        c.castShadow = true;
                        c.receiveShadow = true;
                    }
                });

                model.visible = false;
                this._scene.add(model);
                this._models[name] = model;

                if (onProgress) onProgress(name);
                console.log('[PropManager] loaded ' + name);
            } catch (e) {
                console.warn('[PropManager] failed to load ' + name + ':', e);
                if (onProgress) onProgress(name);
            }
        }
    }

    show(name) {
        const model = this._models[name];
        if (!model || this.isShowing(name)) return;

        model.visible = true;
        model.scale.setScalar(0.01);
        this._active[name] = { mesh: model, state: 'entering', t: 0 };

        const def = this._defs[name];
        if (def.type === 'scene' && def.pos) {
            model.position.set(def.pos[0], def.pos[1], def.pos[2]);
        }
    }

    hide(name) {
        if (!this._active[name]) return;
        this._active[name].state = 'exiting';
        this._active[name].t = 1;
    }

    isShowing(name) {
        return !!this._active[name];
    }

    hideAll() {
        for (const name of Object.keys(this._active)) {
            this.hide(name);
        }
    }

    update(delta) {
        for (const [name, entry] of Object.entries(this._active)) {
            const def = this._defs[name];

            if (entry.state === 'entering') {
                entry.t = Math.min(entry.t + delta / 0.3, 1);
                entry.mesh.scale.setScalar(entry.t * (def.scale || 1));
                if (entry.t >= 1) entry.state = 'active';
            } else if (entry.state === 'exiting') {
                entry.t = Math.max(entry.t - delta / 0.3, 0);
                entry.mesh.scale.setScalar(entry.t * (def.scale || 1));
                if (entry.t <= 0) {
                    entry.mesh.visible = false;
                    delete this._active[name];
                    continue;
                }
            }

            // Bone-attached: follow bone each frame (same technique as hat system)
            if (def.type === 'bone' && this._bones[def.bone] && this._tempVec) {
                const bone = this._bones[def.bone];
                bone.getWorldPosition(this._tempVec);
                bone.getWorldQuaternion(this._tempQuat);

                // Offset in bone-local space: Y=fwd, Z=-up (same convention as hat system)
                const offset = new this._Vector3(def.offsetSide, def.offsetFwd, -def.offsetUp);
                offset.applyQuaternion(this._tempQuat);
                entry.mesh.position.copy(this._tempVec).add(offset);

                // Apply correction quaternion (-90 deg X) to keep props upright
                entry.mesh.quaternion.copy(this._tempQuat);
                if (this._correctionQuat) {
                    entry.mesh.quaternion.multiply(this._correctionQuat);
                }
                // Apply per-prop rotation offsets (axis-angle, no THREE.Euler needed)
                if (def.rotX) {
                    const q = new this._Quaternion().setFromAxisAngle(new this._Vector3(1, 0, 0), def.rotX);
                    entry.mesh.quaternion.multiply(q);
                }
                if (def.rotY) {
                    const q = new this._Quaternion().setFromAxisAngle(new this._Vector3(0, 1, 0), def.rotY);
                    entry.mesh.quaternion.multiply(q);
                }
                if (def.rotZ) {
                    const q = new this._Quaternion().setFromAxisAngle(new this._Vector3(0, 0, 1), def.rotZ);
                    entry.mesh.quaternion.multiply(q);
                }
            }
        }
    }

    animateRubberDuck(time) {
        const entry = this._active['rubber-duck'];
        if (!entry || entry.state !== 'active') return;
        const model = entry.mesh;
        const elapsed = (entry._duckTime = (entry._duckTime || 0) + 0.016);
        if (elapsed < 3) {
            model.position.y = -1 + (elapsed / 3) * 3;
        } else if (elapsed < 5) {
            model.position.y = 2 + Math.sin(elapsed * 3) * 0.15;
        } else if (elapsed < 8) {
            model.position.y = 2 - ((elapsed - 5) / 3) * 3;
        } else {
            this.hide('rubber-duck');
            entry._duckTime = 0;
        }
    }
}
