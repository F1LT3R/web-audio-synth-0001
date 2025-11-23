const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx;
let isPlaying = false;
let arpInterval = null;

// Constants
const waveforms = ['sine', 'square', 'sawtooth', 'triangle'];
const arpPattern = [0, 4, 7, 12]; 
let arpIndex = 0;
const MAX_VOICES = 8;

// MIDI State
let midiAccess = null;
let midiInput = null; // Notes Input
let midiCCInput = null; // CC Input
let selectedMidiDevice = "-1";
let selectedMidiCCDevice = "-1";
let selectedMidiChannel = -1; // -1 = Omni

// Default Settings
const defaultSettings = {
    arpEnabled: false,
    arpRate: 120,
    // Osc 1
    osc1_waveform: 2,
    osc1_octave: 0,
    osc1_semi: 0,
    osc1_detune: 0,
    osc1_pan: 0,
    osc1_gain: 0.5,
    // Osc 2
    osc2_waveform: 2,
    osc2_octave: 0,
    osc2_semi: 0,
    osc2_detune: 0,
    osc2_pan: 0,
    osc2_gain: 0.5,
    // Osc 3
    osc3_waveform: 2,
    osc3_octave: -1,
    osc3_semi: 0,
    osc3_detune: 0,
    osc3_pan: 0,
    osc3_gain: 0.5,
    // Filter
    filterType: 'lowpass',
    filterFreq: 2000,
    filterQ: 1,
    filterEnvAmt: 0,
    // Filter ADSR
    f_attack: 0.1,
    f_decay: 0.1,
    f_sustain: 0.5,
    f_release: 0.5,
    // Amp ADSR
    attack: 0.1,
    decay: 0.1,
    sustain: 0.5,
    release: 0.5,
    // Tremolo
    tremRate: 5,
    tremDepth: 0,
    // Master
    pan: 0,
    volume: 0.5
};

let settings = { ...defaultSettings };

// Voice Class for Polyphony
class SynthVoice {
    constructor(ctx, dest) {
        this.ctx = ctx;
        this.dest = dest;
        this.oscillators = [];
        this.oscGains = []; // Store gains for live mixing
        this.oscPans = []; 
        this.filter = null;
        this.ampEnv = null;
        this.masterPan = null; 
        this.tremolo = { osc: null, gain: null, depthNode: null }; // Added depthNode
        this.filterEnvSrc = null; 
        this.filterEnvGain = null; 
        this.active = false;
        this.note = null; 
    }

    trigger(freq, noteNum) {
        this.note = noteNum;
        this.active = true;
        const now = this.ctx.currentTime;

        // 1. Create Graph Chain
        
        // Master Pan
        if (this.ctx.createStereoPanner) {
            this.masterPan = this.ctx.createStereoPanner();
            this.masterPan.pan.value = settings.pan;
        } else {
            this.masterPan = this.ctx.createGain(); 
        }

        // Tremolo
        const tremGain = this.ctx.createGain();
        tremGain.gain.value = 1;
        
        const tremOsc = this.ctx.createOscillator();
        tremOsc.frequency.value = settings.tremRate;
        const tremDepthGain = this.ctx.createGain();
        tremDepthGain.gain.value = settings.tremDepth;
        
        tremOsc.connect(tremDepthGain);
        tremDepthGain.connect(tremGain.gain);
        tremOsc.start(now);
        this.tremolo = { osc: tremOsc, gain: tremGain, depthNode: tremDepthGain };

        // Amp (VCA)
        this.ampEnv = this.ctx.createGain();
        this.ampEnv.gain.value = 0;

        // Filter
        this.filter = this.ctx.createBiquadFilter();
        this.filter.type = settings.filterType;
        
        let baseF = settings.filterFreq;
        if (settings.filterType === 'lowpass' && baseF > 10000) baseF = 10000;
        this.filter.frequency.value = baseF;
        this.filter.Q.value = settings.filterQ;

        // Filter Envelope Modulation
        this.filterEnvSrc = this.ctx.createConstantSource();
        this.filterEnvSrc.offset.value = 0;
        this.filterEnvGain = this.ctx.createGain();
        this.filterEnvGain.gain.value = settings.filterEnvAmt;
        
        this.filterEnvSrc.connect(this.filterEnvGain);
        this.filterEnvGain.connect(this.filter.frequency);
        this.filterEnvSrc.start(now);

        // Chain Construction
        this.filter.connect(this.ampEnv);
        this.ampEnv.connect(tremGain);
        tremGain.connect(this.masterPan);
        this.masterPan.connect(this.dest);

        // Oscillators
        this.oscillators = [];
        this.oscGains = [];
        this.oscPans = [];
        
        for (let i = 1; i <= 3; i++) {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            let panNode;

            if (this.ctx.createStereoPanner) {
                panNode = this.ctx.createStereoPanner();
                panNode.pan.value = settings[`osc${i}_pan`];
            } else {
                panNode = this.ctx.createGain();
            }
            
            osc.type = waveforms[settings[`osc${i}_waveform`]];
            osc.frequency.value = freq;
            
            const oct = settings[`osc${i}_octave`];
            const semi = settings[`osc${i}_semi`];
            const fine = settings[`osc${i}_detune`];
            const totalCents = (oct * 1200) + (semi * 100) + fine;
            
            osc.detune.value = totalCents;
            gain.gain.value = settings[`osc${i}_gain`];
            
            osc.connect(gain);
            gain.connect(panNode);
            panNode.connect(this.filter);
            
            osc.start(now);
            
            this.oscillators.push(osc);
            this.oscGains.push(gain);
            this.oscPans.push(panNode);
        }

        // Envelopes
        // Amp
        const a = Math.max(0.001, settings.attack);
        const d = Math.max(0.001, settings.decay);
        const s = Math.max(0.0001, settings.sustain);
        
        this.ampEnv.gain.cancelScheduledValues(now);
        this.ampEnv.gain.setValueAtTime(0, now);
        this.ampEnv.gain.linearRampToValueAtTime(1, now + a);
        this.ampEnv.gain.exponentialRampToValueAtTime(s, now + a + d);

        // Filter Env
        const fa = Math.max(0.001, settings.f_attack);
        const fd = Math.max(0.001, settings.f_decay);
        const fs = settings.f_sustain;
        
        this.filterEnvSrc.offset.cancelScheduledValues(now);
        this.filterEnvSrc.offset.setValueAtTime(0, now);
        this.filterEnvSrc.offset.linearRampToValueAtTime(1, now + fa);
        this.filterEnvSrc.offset.linearRampToValueAtTime(fs, now + fa + fd);
    }

    release() {
        if (!this.active) return;
        this.active = false;
        const now = this.ctx.currentTime;
        const r = Math.max(0.001, settings.release);
        const fr = Math.max(0.001, settings.f_release);

        if (this.ampEnv) {
            this.ampEnv.gain.cancelScheduledValues(now);
            this.ampEnv.gain.setValueAtTime(this.ampEnv.gain.value, now);
            this.ampEnv.gain.linearRampToValueAtTime(0, now + r);
        }

        if (this.filterEnvSrc) {
            this.filterEnvSrc.offset.cancelScheduledValues(now);
            this.filterEnvSrc.offset.setValueAtTime(this.filterEnvSrc.offset.value, now);
            this.filterEnvSrc.offset.linearRampToValueAtTime(0, now + fr);
        }

        const stopTime = now + r + 0.1;
        this.oscillators.forEach(osc => osc.stop(stopTime));
        if (this.tremolo.osc) this.tremolo.osc.stop(stopTime);
        if (this.filterEnvSrc) this.filterEnvSrc.stop(stopTime + fr);

        setTimeout(() => {
            this.disconnect();
        }, (Math.max(r, fr) + 0.2) * 1000);
    }

    disconnect() {
        this.oscillators.forEach(o => { try { o.disconnect(); } catch(e){} });
        this.oscGains.forEach(g => { try { g.disconnect(); } catch(e){} });
        this.oscPans.forEach(p => { try { p.disconnect(); } catch(e){} });
        if (this.filter) { try { this.filter.disconnect(); } catch(e){} }
        if (this.ampEnv) { try { this.ampEnv.disconnect(); } catch(e){} }
        if (this.masterPan) { try { this.masterPan.disconnect(); } catch(e){} }
        if (this.tremolo.osc) { try { this.tremolo.osc.disconnect(); } catch(e){} }
        if (this.tremolo.gain) { try { this.tremolo.gain.disconnect(); } catch(e){} }
        if (this.tremolo.depthNode) { try { this.tremolo.depthNode.disconnect(); } catch(e){} }
        if (this.filterEnvSrc) { try { this.filterEnvSrc.disconnect(); } catch(e){} }
        if (this.filterEnvGain) { try { this.filterEnvGain.disconnect(); } catch(e){} }
        this.note = null;
    }
    
    updateParams(param, value) {
        if (!this.active) return;
        const now = this.ctx.currentTime;
        const smooth = 0.05;
        
        // Filter
        if (param === 'filterFreq' && this.filter) {
             let target = value;
             if (settings.filterType === 'lowpass' && target > 10000) target = 10000;
             this.filter.frequency.setTargetAtTime(target, now, smooth);
        }
        if (param === 'filterEnvAmt' && this.filterEnvGain) {
             this.filterEnvGain.gain.setTargetAtTime(value, now, smooth);
        }
        if (param === 'filterQ' && this.filter) this.filter.Q.setTargetAtTime(value, now, smooth);
        
        // Tremolo
        if (param === 'tremRate' && this.tremolo.osc) this.tremolo.osc.frequency.setTargetAtTime(value, now, smooth);
        if (param === 'tremDepth' && this.tremolo.depthNode) this.tremolo.depthNode.gain.setTargetAtTime(value, now, smooth);
        
        // Master Pan
        if (param === 'pan' && this.masterPan && this.masterPan.pan) {
             this.masterPan.pan.setTargetAtTime(value, now, smooth);
        }

        // Oscillators (Dynamic Index)
        // Param format: osc1_gain, osc2_pan, etc.
        if (param.startsWith('osc')) {
            // Parse index
            const match = param.match(/osc(\d+)_(\w+)/);
            if (match) {
                const index = parseInt(match[1]) - 1; // 0-indexed
                const type = match[2];
                
                if (this.oscillators[index]) {
                    if (type === 'gain' && this.oscGains[index]) {
                        this.oscGains[index].gain.setTargetAtTime(value, now, smooth);
                    }
                    if (type === 'pan' && this.oscPans[index] && this.oscPans[index].pan) {
                        this.oscPans[index].pan.setTargetAtTime(value, now, smooth);
                    }
                    if ((type === 'detune' || type === 'semi' || type === 'octave') && this.oscillators[index]) {
                        // Recalculate total detune
                        const oct = settings[`osc${index+1}_octave`];
                        const semi = settings[`osc${index+1}_semi`];
                        const fine = settings[`osc${index+1}_detune`];
                        const totalCents = (oct * 1200) + (semi * 100) + fine;
                        this.oscillators[index].detune.setTargetAtTime(totalCents, now, smooth);
                    }
                    if (type === 'waveform') {
                        this.oscillators[index].type = waveforms[value];
                    }
                }
            }
        }
    }
}

// Global Audio State
let masterGainNode = null;
let activeVoices = new Map();

// UI State
const uiElements = {};
const paramMap = {
    arpEnabled: { type: 'checkbox' },
    arpRate: { min: 60, max: 240, step: 1, type: 'range' },

    filterType: { type: 'select' },
    filterFreq: { min: 20, max: 20000, step: 1, type: 'range' },
    filterQ: { min: 0, max: 20, step: 0.1, type: 'range' },
    filterEnvAmt: { min: -5000, max: 5000, step: 10, type: 'range' },
    
    f_attack: { min: 0, max: 2, step: 0.01, type: 'range' },
    f_decay: { min: 0, max: 2, step: 0.01, type: 'range' },
    f_sustain: { min: 0, max: 1, step: 0.01, type: 'range' },
    f_release: { min: 0, max: 3, step: 0.01, type: 'range' },

    attack: { min: 0, max: 2, step: 0.01, type: 'range' },
    decay: { min: 0, max: 2, step: 0.01, type: 'range' },
    sustain: { min: 0, max: 1, step: 0.01, type: 'range' },
    release: { min: 0, max: 3, step: 0.01, type: 'range' },

    tremRate: { min: 0.1, max: 20, step: 0.1, type: 'dial' },
    tremDepth: { min: 0, max: 1, step: 0.01, type: 'dial' },
    
    pan: { min: -1, max: 1, step: 0.05, type: 'dial' },
    volume: { min: 0, max: 1, step: 0.01, type: 'range' }
};

for (let i = 1; i <= 3; i++) {
    paramMap[`osc${i}_waveform`] = { min: 0, max: 3, step: 1, type: 'dial' };
    paramMap[`osc${i}_octave`] = { min: -2, max: 2, step: 1, type: 'dial' };
    paramMap[`osc${i}_semi`] = { min: -12, max: 12, step: 1, type: 'dial' };
    paramMap[`osc${i}_detune`] = { min: -50, max: 50, step: 1, type: 'dial' };
    paramMap[`osc${i}_pan`] = { min: -1, max: 1, step: 0.05, type: 'dial' };
    paramMap[`osc${i}_gain`] = { min: 0, max: 1, step: 0.01, type: 'dial' };
}

document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    initUI();
    initMidi();
    setupEventListeners();
    
    document.body.addEventListener('click', () => {
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    }, { once: true });
});

function initAudio() {
    if (!audioCtx) {
        // Low latency hint and forced sample rate
        audioCtx = new AudioContext({ 
            latencyHint: 'interactive',
            sampleRate: 48000 
        });
        masterGainNode = audioCtx.createGain();
        masterGainNode.connect(audioCtx.destination);
        masterGainNode.gain.value = settings.volume;
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(e => console.error(e));
    }
}

// --- MIDI Setup ---
function initMidi() {
    if (navigator.requestMIDIAccess) {
        navigator.requestMIDIAccess().then(onMIDISuccess, onMIDIFailure);
    } else {
        console.warn("Web MIDI API not supported in this browser.");
    }
}

function onMIDISuccess(midi) {
    midiAccess = midi;
    updateMidiDevices();
    midi.onstatechange = updateMidiDevices;
}

function onMIDIFailure(msg) {
    console.error("Failed to get MIDI access - " + msg);
}

function updateMidiDevices() {
    const inputs = midiAccess.inputs;
    const selectNote = document.getElementById('midi-device');
    const selectCC = document.getElementById('midi-cc-device');
    
    const currentNote = selectNote.value;
    const currentCC = selectCC.value;
    
    const opts = '<option value="-1">No Device</option>';
    selectNote.innerHTML = opts;
    selectCC.innerHTML = opts;
    
    for (let input of inputs.values()) {
        const opt1 = document.createElement('option');
        opt1.value = input.id;
        opt1.text = input.name;
        selectNote.appendChild(opt1);

        const opt2 = document.createElement('option');
        opt2.value = input.id;
        opt2.text = input.name;
        selectCC.appendChild(opt2);
    }
    
    if (Array.from(selectNote.options).some(opt => opt.value === currentNote)) selectNote.value = currentNote;
    if (Array.from(selectCC.options).some(opt => opt.value === currentCC)) selectCC.value = currentCC;
}

function selectMidiDevice(id, type) {
    const inputs = midiAccess.inputs;
    let input = null;
    
    if (id !== "-1") {
        for (let i of inputs.values()) {
            if (i.id === id) { input = i; break; }
        }
    }

    if (type === 'note') {
        midiInput = input;
        selectedMidiDevice = id;
        setupMidiRouting();
    } else {
        midiCCInput = input;
        selectedMidiCCDevice = id;
        setupMidiRouting();
    }
}

function setupMidiRouting() {
    if (midiAccess) {
        for (let input of midiAccess.inputs.values()) {
            input.onmidimessage = null;
        }
    }

    // Router
    if (midiInput && midiCCInput && midiInput.id === midiCCInput.id) {
        midiInput.onmidimessage = (e) => {
            handleNoteMsg(e);
            handleCCMsg(e);
        };
    } else {
        if (midiInput) midiInput.onmidimessage = handleNoteMsg;
        if (midiCCInput) midiCCInput.onmidimessage = handleCCMsg;
    }
}

function handleNoteMsg(event) {
    const [status, data1, data2] = event.data;
    
    // Realtime Clock
    if (status === 0xF8) {
        handleMidiClock();
        return;
    }
    if (status === 0xFA) { 
        if (settings.arpEnabled && !isPlaying) startNoteSequence();
        return;
    }
    if (status === 0xFC) { 
        if (settings.arpEnabled && isPlaying) stopNoteSequence();
        return;
    }

    const command = status & 0xf0;
    const channel = status & 0x0f;
    if (selectedMidiChannel !== -1 && channel !== selectedMidiChannel) return;
    
    if (command === 144) { // Note On
        if (data2 > 0) noteOn(data1, data2);
        else noteOff(data1);
    } else if (command === 128) { // Note Off
        noteOff(data1);
    }
}

// MIDI Clock State
let clockTickCount = 0;
let lastClockTime = 0;

function handleMidiClock() {
    if (!settings.arpEnabled || !isPlaying) return;
    
    // 24 ticks per quarter note
    clockTickCount++;
    
    if (clockTickCount >= 12) { // 8th notes
        clockTickCount = 0;
        
        if (arpInterval) {
            clearInterval(arpInterval);
            arpInterval = null;
        }
        
        if (lastArpNote) noteOff(lastArpNote);
        playArpStep();
    }
}

function handleCCMsg(event) {
    const [status, ccNum, val] = event.data;
    const command = status & 0xf0;
    const channel = status & 0x0f;
    if (selectedMidiChannel !== -1 && channel !== selectedMidiChannel) return;

    if (command === 176) { // CC
        mapCC(ccNum, val);
    }
}

function mapCC(cc, val) {
    const norm = val / 127;
    let param = null;
    let mappedVal = null;
    
    // Offset CC to match 1-16 based on user request
    const targetCC = cc + 1;

    switch(targetCC) {
        case 1: // Cutoff
            param = 'filterFreq';
            if (settings.filterType === 'lowpass') {
                mappedVal = 20 * Math.pow(500, norm); // Max 10k
            } else {
                mappedVal = 20 * Math.pow(1000, norm); 
            }
            break;
        case 2: param = 'filterQ'; mappedVal = norm * 20; break;
        case 3: param = 'tremRate'; mappedVal = 0.1 + (norm * 19.9); break;
        case 4: param = 'tremDepth'; mappedVal = norm; break;
        case 5: param = 'attack'; mappedVal = norm * 2; break;
        case 6: param = 'decay'; mappedVal = norm * 2; break;
        case 7: param = 'sustain'; mappedVal = norm; break;
        case 8: param = 'release'; mappedVal = norm * 3; break;
        case 9: param = 'f_attack'; mappedVal = norm * 2; break;
        case 10: param = 'f_decay'; mappedVal = norm * 2; break;
        case 11: param = 'f_sustain'; mappedVal = norm; break;
        case 12: param = 'f_release'; mappedVal = norm * 3; break;
        case 13: param = 'osc1_semi'; mappedVal = Math.round((norm * 24) - 12); break;
        case 14: param = 'osc2_semi'; mappedVal = Math.round((norm * 24) - 12); break;
        case 15: param = 'osc3_semi'; mappedVal = Math.round((norm * 24) - 12); break;
        case 16: param = 'pan'; mappedVal = (norm * 2) - 1; break;
    }

    if (param !== null) {
        settings[param] = mappedVal;
        const el = uiElements[param];
        if (el) {
            if (el.type === 'checkbox') el.checked = mappedVal;
            else {
                updateDialVisual(el, mappedVal);
                el.value = mappedVal;
            }
        }
        updateValueDisplay(param, mappedVal);
        updateAudioParams(param, mappedVal);
    }
}

// --- Setup Listeners ---
function setupEventListeners() {
    document.getElementById('midi-device').addEventListener('change', (e) => selectMidiDevice(e.target.value, 'note'));
    document.getElementById('midi-cc-device').addEventListener('change', (e) => selectMidiDevice(e.target.value, 'cc'));
    document.getElementById('midi-channel').addEventListener('change', (e) => selectedMidiChannel = parseInt(e.target.value));

    document.querySelectorAll('.dial').forEach(dial => {
        dial.addEventListener('mousedown', handleDialStart);
    });

    document.querySelectorAll('input, select').forEach(el => {
        if (el.id.startsWith('midi')) return; 
        
        el.addEventListener('input', (e) => {
            const param = e.target.dataset.param;
            let val;
            if (e.target.type === 'checkbox') val = e.target.checked;
            else if (e.target.type === 'range') val = parseFloat(e.target.value);
            else val = e.target.value;

            settings[param] = val;
            updateValueDisplay(param, val);
            
            if (param === 'arpEnabled' || param === 'arpRate') {
                handleArpChange();
            } else {
                updateAudioParams(param, val);
            }
            saveSettings();
        });
    });

    const playBtn = document.getElementById('play-btn');
    playBtn.addEventListener('mousedown', () => startNoteSequence()); 
    playBtn.addEventListener('mouseup', () => stopNoteSequence());
    playBtn.addEventListener('mouseleave', () => { if (isPlaying) stopNoteSequence(); });
    
    playBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startNoteSequence(); });
    playBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopNoteSequence(); });

    document.getElementById('randomize-btn').addEventListener('click', randomizeSettings);
    document.getElementById('reset-btn').addEventListener('click', resetSettings);
}

// --- Polyphonic Note Logic ---

function noteOn(noteNum, velocity = 127) {
    initAudio();
    if (activeVoices.size >= MAX_VOICES) {
        const firstNote = activeVoices.keys().next().value;
        const oldVoice = activeVoices.get(firstNote);
        oldVoice.release();
        activeVoices.delete(firstNote);
    }

    const freq = 440 * Math.pow(2, (noteNum - 69) / 12);
    const voice = new SynthVoice(audioCtx, masterGainNode);
    voice.trigger(freq, noteNum);
    activeVoices.set(noteNum, voice);
}

function noteOff(noteNum) {
    const voice = activeVoices.get(noteNum);
    if (voice) {
        voice.release();
        activeVoices.delete(noteNum);
    }
}

// --- Arp / Mouse Interaction Shim ---

function startNoteSequence() {
    initAudio();
    if (isPlaying) return;
    isPlaying = true;
    document.getElementById('play-btn').classList.add('active');

    if (settings.arpEnabled) {
        startArp();
    } else {
        noteOn(60, 127); // C4
    }
}

function stopNoteSequence() {
    if (!isPlaying) return;
    isPlaying = false;
    document.getElementById('play-btn').classList.remove('active');
    
    if (arpInterval) {
        clearInterval(arpInterval);
        arpInterval = null;
    }
    
    if (activeVoices.has(60) && !settings.arpEnabled) {
        noteOff(60);
    } else {
        if (lastArpNote) noteOff(lastArpNote);
    }
}

let lastArpNote = null;

function startArp() {
    arpIndex = 0;
    const ms = 60000 / settings.arpRate / 2;
    playArpStep();
    arpInterval = setInterval(() => {
        if (!isPlaying) {
            clearInterval(arpInterval);
            return;
        }
        if (lastArpNote) noteOff(lastArpNote);
        playArpStep();
    }, ms);
}

function playArpStep() {
    const baseNote = 60; 
    const offset = arpPattern[arpIndex % arpPattern.length];
    arpIndex++;
    lastArpNote = baseNote + offset;
    noteOn(lastArpNote, 100);
}

function handleArpChange() {
    if (isPlaying && settings.arpEnabled && !arpInterval) {
        stopNoteSequence(); 
        startNoteSequence();
    } else if (isPlaying && !settings.arpEnabled && arpInterval) {
        clearInterval(arpInterval);
        arpInterval = null;
        if (lastArpNote) noteOff(lastArpNote);
        noteOn(60, 127);
    } else if (isPlaying && settings.arpEnabled && arpInterval) {
        clearInterval(arpInterval);
        startArp();
    }
}

function updateAudioParams(param, value) {
    if (param === 'volume' && masterGainNode) {
        masterGainNode.gain.setTargetAtTime(value, audioCtx.currentTime, 0.01);
    }
    activeVoices.forEach(voice => {
        voice.updateParams(param, value);
    });
}

// --- Helpers ---

function loadSettings() {
    const saved = localStorage.getItem('synthSettings');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            settings = { ...defaultSettings, ...parsed };
        } catch (e) { settings = { ...defaultSettings }; }
    }
}

function saveSettings() {
    localStorage.setItem('synthSettings', JSON.stringify(settings));
}

function initUI() {
    document.querySelectorAll('.dial').forEach(dial => {
        const param = dial.dataset.param;
        if (param) {
            uiElements[param] = dial;
            updateDialVisual(dial, settings[param]);
        }
    });
    document.querySelectorAll('input, select').forEach(el => {
        if (el.id.startsWith('midi')) return;
        const param = el.dataset.param;
        if (param) {
            uiElements[param] = el;
            if (el.type === 'checkbox') el.checked = settings[param];
            else el.value = settings[param];
            updateValueDisplay(param, settings[param]);
        }
    });
}

function updateValueDisplay(param, value) {
    let displayValue = value;
    let elId = `disp-${param}`;
    
    if (param.includes('waveform')) displayValue = waveforms[value] ? waveforms[value].charAt(0).toUpperCase() + waveforms[value].slice(1) : 'Sine';
    else if (param.includes('Freq')) displayValue = `${Math.round(value)} Hz`;
    else if (param === 'arpRate') displayValue = `${value} BPM`;
    
    if (paramMap[param] && paramMap[param].type === 'dial') {
        const dial = uiElements[param];
        if (dial) {
            const valEl = dial.querySelector('.dial-value');
            if (valEl) valEl.textContent = displayValue;
        }
    } else {
        const dispEl = document.getElementById(elId);
        if (dispEl) dispEl.textContent = displayValue;
    }
}

let activeDial = null;
let startY = 0;
let startVal = 0;

function handleDialStart(e) {
    activeDial = e.currentTarget;
    startY = e.clientY;
    startVal = parseFloat(settings[activeDial.dataset.param]);
    document.addEventListener('mousemove', handleDialMove);
    document.addEventListener('mouseup', handleDialEnd);
    e.preventDefault();
}

function handleDialMove(e) {
    if (!activeDial) return;
    const param = activeDial.dataset.param;
    const conf = paramMap[param];
    const deltaY = startY - e.clientY;
    const range = conf.max - conf.min;
    let newVal = startVal + (deltaY / 200) * range;
    newVal = Math.max(conf.min, Math.min(conf.max, newVal));
    if (conf.step) newVal = Math.round(newVal / conf.step) * conf.step;
    
    settings[param] = newVal;
    updateDialVisual(activeDial, newVal);
    updateValueDisplay(param, newVal);
    updateAudioParams(param, newVal);
}

function handleDialEnd() {
    if (activeDial) saveSettings();
    activeDial = null;
    document.removeEventListener('mousemove', handleDialMove);
    document.removeEventListener('mouseup', handleDialEnd);
}

function updateDialVisual(dial, value) {
    const min = parseFloat(dial.dataset.min);
    const max = parseFloat(dial.dataset.max);
    const pct = (value - min) / (max - min);
    const angle = -135 + (pct * 270);
    const knob = dial.querySelector('.dial-knob');
    if (knob) knob.style.transform = `rotate(${angle}deg)`;
}

function randomizeSettings() {
    Object.keys(paramMap).forEach(key => {
        if (key === 'volume' || key === 'arpEnabled') return;
        const conf = paramMap[key];
        let rnd;
        if (conf.type === 'select') {
             const opts = ['lowpass', 'highpass', 'bandpass', 'notch'];
             rnd = opts[Math.floor(Math.random() * opts.length)];
        } else {
             rnd = Math.random() * (conf.max - conf.min) + conf.min;
             if (conf.step) rnd = Math.round(rnd / conf.step) * conf.step;
        }
        settings[key] = rnd;
    });
    initUI();
    saveSettings();
}

function resetSettings() {
    settings = { ...defaultSettings };
    initUI();
    saveSettings();
}
