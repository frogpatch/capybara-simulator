// js/reaction-system.js
// Two-layer reaction system:
// Layer 1 — Deadpan reactions driven by face tracker state
// Layer 2 — Chaotic one-shot events (random + behavior-triggered)

export class ReactionSystem {
    constructor({ mixer, animActions, faceTracker, propManager }) {
        this._mixer = mixer;
        this._actions = animActions;
        this._face = faceTracker;
        this._props = propManager;

        this._currentAnim = 'Confused_Scratch';
        this._state = 'idle';
        this._paused = false;

        // Deadpan state
        this._musicPlaying = false;
        this._lastReactionTime = 0;
        this._stopSignShown = false;
        this._closeStartTime = 0;
        this._stillStartTime = 0;
        this._absentTriggered = false;
        this._wearingSunglasses = false;
        this._holdingMagazine = false;
        this._pendingTimeouts = [];

        // Chaotic event system
        this._chaoticCooldown = 0;
        this._globalCooldown = 10;
        this._activeChaoticEvent = null;
        this._chaoticTimer = 0;
        this._eventCooldowns = {};

        this._chaoticEvents = [
            { name: 'rubber-duck', minInterval: 15, maxInterval: 40, duration: 8 },
            { name: 'boombox-walk', minInterval: 25, maxInterval: 50, duration: 10 },
            { name: 'punch-combo', minInterval: 35, maxInterval: 60, duration: 4 },
            { name: 'tantrum', minInterval: 45, maxInterval: 70, duration: 5 },
            { name: 'dramatic-faint', minInterval: 55, maxInterval: 90, duration: 5 },
            { name: 'panic-run', minInterval: 60, maxInterval: 90, duration: 5 },
            { name: 'coffee-break', minInterval: 40, maxInterval: 70, duration: 8 },
        ];

        this._nextEventTimes = {};
        for (const evt of this._chaoticEvents) {
            this._nextEventTimes[evt.name] = this._randomBetween(evt.minInterval, evt.maxInterval);
        }
        this._totalTime = 0;

        // Callbacks
        this._onBoomboxWalk = null;
        this._onVaporwaveFlash = null;
        this._onScreenShake = null;
        this._onFlowerShockwave = null;
    }

    pause() { this._paused = true; }
    resume() { this._paused = false; }

    reset() {
        this._absentTriggered = false;
        this._closeStartTime = 0;
        this._stillStartTime = 0;
        this._stopSignShown = false;
        if (this._wearingSunglasses) { this._props?.hide('sunglasses'); this._wearingSunglasses = false; }
        if (this._holdingMagazine) { this._props?.hide('magazine'); this._holdingMagazine = false; }
        for (const id of this._pendingTimeouts) clearTimeout(id);
        this._pendingTimeouts = [];
        this._playAnim('Confused_Scratch', true);
        this._state = 'idle';
    }

    onMusicSkip() {
        if (this._paused || this._activeChaoticEvent) return;
        this._triggerChaotic('boombox', 5);
    }

    onRainToggle() {
        if (this._paused || this._activeChaoticEvent) return;
        this._triggerChaotic('beach-umbrella', 6);
    }

    getHeadTiltOverride(headPose) {
        if (!headPose || !this._face?.isPresent) return null;
        if (this._state === 'chaotic') return null;
        return {
            tiltX: -headPose.tiltX * 0.3,
            tiltY: -headPose.tiltY * 0.6,
        };
    }

    update(delta) {
        if (this._paused) return;
        this._totalTime += delta;

        this._chaoticCooldown = Math.max(0, this._chaoticCooldown - delta);
        for (const key of Object.keys(this._eventCooldowns)) {
            this._eventCooldowns[key] = Math.max(0, this._eventCooldowns[key] - delta);
        }

        if (this._activeChaoticEvent) {
            this._chaoticTimer -= delta;
            if (this._chaoticTimer <= 0) this._endChaoticEvent();
            return;
        }

        this._checkRandomChaotics();

        if (this._face && this._face.isActive) {
            this._updateDeadpanReactions(delta);
        }
    }

    _updateDeadpanReactions(delta) {
        const face = this._face;

        // === PLAYER DISAPPEARED ===
        // Face not detected for more than 3 seconds
        if (!face.isPresent && face.timeSinceLeft > 3 && !this._absentTriggered) {
            this._absentTriggered = true;
            this._playAnim('Look_Around_Dumbfounded', false);
            // After 3 more seconds, show magazine and go back to idle (reading)
            const tid = setTimeout(() => {
                if (!face.isPresent && this._props) {
                    this._props.show('magazine');
                    this._holdingMagazine = true;
                    // Return to idle while "reading" the magazine
                    this._playAnim('Confused_Scratch', true);
                }
            }, 3000);
            this._pendingTimeouts.push(tid);
            return;
        }

        // === PLAYER RETURNED ===
        if (face.isPresent && this._absentTriggered) {
            this._absentTriggered = false;
            if (this._holdingMagazine) {
                const tid = setTimeout(() => {
                    if (this._props) this._props.hide('magazine');
                    this._holdingMagazine = false;
                    this._playAnim('Confused_Scratch', true);
                }, 2000);
                this._pendingTimeouts.push(tid);
            } else {
                this._playAnim('Confused_Scratch', true);
            }
            return;
        }

        if (!face.isPresent) return;

        // === PLAYER TOO CLOSE ===
        // Z is POSITIVE when closer: 0 = normal, +0.5 = noticeably close, +1.5 = very close
        const isClose = face.headPose.z > 0.5;

        if (isClose) {
            if (this._closeStartTime === 0) this._closeStartTime = this._totalTime;
            const closeDuration = this._totalTime - this._closeStartTime;

            // Escalation: still close after stop sign
            if (closeDuration > 12 && this._stopSignShown && !this._activeChaoticEvent) {
                this._stopSignShown = false;
                this._triggerChaotic('angry-stomp', 3);
                this._closeStartTime = 0;
                return;
            }

            if (closeDuration > 8 && !this._activeChaoticEvent && !this._stopSignShown) {
                this._triggerChaotic('stop-sign', 4);
                this._stopSignShown = true;
                this._closeStartTime = 0;
            } else if (closeDuration > 4 && !this._wearingSunglasses) {
                this._playAnim('Slap_Reaction', true);
                this._props?.show('sunglasses');
                this._wearingSunglasses = true;
            } else if (closeDuration > 2 && closeDuration <= 4 && this._currentAnim !== 'Slap_Reaction') {
                this._playAnim('Slap_Reaction', true);
            }

            this._stillStartTime = 0;
            return;
        }

        // NOT close — always reset close state immediately
        if (this._closeStartTime > 0 || this._wearingSunglasses || this._currentAnim === 'Slap_Reaction') {
            this._closeStartTime = 0;
            this._stopSignShown = false;
            if (this._wearingSunglasses) {
                this._props?.hide('sunglasses');
                this._wearingSunglasses = false;
            }
            this._playAnim('Confused_Scratch', true);
        }

        // === PLAYER STILL FOR A LONG TIME ===
        const movement = Math.abs(face.headPose.x) + Math.abs(face.headPose.y);
        if (movement < 0.15) {
            if (this._stillStartTime === 0) this._stillStartTime = this._totalTime;
            if (this._totalTime - this._stillStartTime > 20) {
                this._playAnim('Stand_and_Drink', false);
                this._props?.show('coffee-cup');
                const tid = setTimeout(() => {
                    this._props?.hide('coffee-cup');
                    this._playAnim('Confused_Scratch', true);
                    this._lastReactionTime = this._totalTime;
                }, 4000);
                this._pendingTimeouts.push(tid);
                this._stillStartTime = 0;
                return;
            }
        } else {
            this._stillStartTime = 0;
        }

        // === DEFAULT IDLE ===
        // If moving while Bass_Beats is playing, switch back to Confused_Scratch
        if (this._currentAnim === 'Bass_Beats' && movement > 0.2) {
            this._playAnim('Confused_Scratch', true);
            this._lastReactionTime = this._totalTime;
        }
        // If no animation is playing (or something unexpected), reset to idle
        if (this._state === 'idle' && this._currentAnim !== 'Bass_Beats' && this._currentAnim !== 'Confused_Scratch') {
            this._playAnim('Confused_Scratch', true);
        }
        // Swap to Bass_Beats after 15s of calm presence with music
        if (this._state === 'idle' && this._musicPlaying && face.isPresent
            && this._currentAnim === 'Confused_Scratch'
            && movement < 0.1
            && this._totalTime - (this._lastReactionTime || 0) > 15) {
            this._playAnim('Bass_Beats', true);
            this._lastReactionTime = this._totalTime;
        }
    }

    _checkRandomChaotics() {
        if (this._chaoticCooldown > 0 || this._activeChaoticEvent) return;
        for (const evt of this._chaoticEvents) {
            if (this._totalTime >= (this._nextEventTimes[evt.name] || Infinity)) {
                if (!this._eventCooldowns[evt.name]) {
                    this._triggerChaotic(evt.name, evt.duration);
                    this._nextEventTimes[evt.name] = this._totalTime + this._randomBetween(evt.minInterval, evt.maxInterval);
                    return;
                }
            }
        }
    }

    _triggerChaotic(name, duration) {
        this._activeChaoticEvent = name;
        this._chaoticTimer = duration;
        this._state = 'chaotic';
        console.log('[Reaction] chaotic: ' + name);

        switch (name) {
            case 'rubber-duck': this._props?.show('rubber-duck'); break;
            case 'boombox-walk': if (this._onBoomboxWalk) this._onBoomboxWalk(); break;
            case 'stop-sign':
                this._props?.show('stop-sign');
                this._playAnim('Block1', true);
                break;
            case 'punch-combo': this._playAnim('Punch_Combo', false); break;
            case 'tantrum': this._playAnim('Angry_To_Tantrum_Sit', false); break;
            case 'dramatic-faint':
                this._playAnim('dying_backwards', false);
                if (this._onVaporwaveFlash) this._onVaporwaveFlash();
                break;
            case 'angry-stomp':
                this._playAnim('Angry_Stomp', false);
                if (this._onScreenShake) this._onScreenShake();
                break;
            case 'panic-run':
                this._playAnim('RunFast', true);
                this._panicRunActive = true;
                break;
            case 'boombox':
                this._props?.show('boombox');
                this._playAnim('Bass_Beats', false);
                break;
            case 'beach-umbrella': this._props?.show('beach-umbrella'); break;
            case 'coffee-break':
                this._props?.show('coffee-cup');
                this._playAnim('Stand_and_Drink', false);
                break;
        }
    }

    _endChaoticEvent() {
        const name = this._activeChaoticEvent;
        console.log('[Reaction] ended: ' + name);

        switch (name) {
            case 'rubber-duck': this._props?.hide('rubber-duck'); break;
            case 'stop-sign': this._props?.hide('stop-sign'); break;
            case 'boombox': this._props?.hide('boombox'); break;
            case 'beach-umbrella': this._props?.hide('beach-umbrella'); break;
            case 'panic-run': this._panicRunActive = false; break;
            case 'coffee-break': this._props?.hide('coffee-cup'); break;
        }

        if (this._onFlowerShockwave) this._onFlowerShockwave();

        this._activeChaoticEvent = null;
        this._chaoticCooldown = this._globalCooldown;
        this._eventCooldowns[name] = 60;
        this._state = 'idle';
        this._lastReactionTime = this._totalTime;
        this._playAnim('Confused_Scratch', true);
    }

    _playAnim(name, loop) {
        if (this._currentAnim === name) return;
        const action = this._actions?.[name];
        if (!action) return;

        const current = this._actions?.[this._currentAnim];
        if (current) current.fadeOut(0.3);

        action.reset();
        action.setLoop(loop ? 2201 : 2200);
        if (!loop) action.clampWhenFinished = true;
        action.fadeIn(0.3).play();

        this._currentAnim = name;
    }

    get isPanicRunning() { return !!this._panicRunActive; }
    set onBoomboxWalk(fn) { this._onBoomboxWalk = fn; }
    set onVaporwaveFlash(fn) { this._onVaporwaveFlash = fn; }
    set onScreenShake(fn) { this._onScreenShake = fn; }
    set onFlowerShockwave(fn) { this._onFlowerShockwave = fn; }

    _randomBetween(min, max) {
        return min + Math.random() * (max - min);
    }
}
