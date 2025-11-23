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
let midiInput = null;
let selectedMidiDevice = "-1";
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
    osc1_gain: 0.5,
    // Osc 2
    osc2_waveform: 2,
    osc2_octave: 0,
    osc2_semi: 0,
    osc2_detune: 0,
    osc2_gain: 0.5,
    // Osc 3
    osc3_waveform: 2,
    osc3_octave: -1,
    osc3_semi: 0,
    osc3_detune: 0,
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
        this.filter = null;
        this.ampEnv = null;
        this.pan = null;
        this.tremolo = { osc: null, gain: null };
        this.active = false;
        this.note = null; // MIDI note number
    }

    trigger(freq, noteNum) {
        this.note = noteNum;
        this.active = true;
        const now = this.ctx.currentTime;

        // 1. Create Graph
        // Master -> Pan -> Tremolo -> Amp -> Filter -> Mixer -> Oscs
        // Reverse connection logic
        
        // Amp (VCA)
        this.ampEnv = this.ctx.createGain();
        this.ampEnv.gain.value = 0;

        // Pan
        if (this.ctx.createStereoPanner) {
            this.pan = this.ctx.createStereoPanner();
            this.pan.pan.value = settings.pan;
        } else {
            this.pan = this.ctx.createGain(); 
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
        this.tremolo = { osc: tremOsc, gain: tremGain };

        // Filter
        this.filter = this.ctx.createBiquadFilter();
        this.filter.type = settings.filterType;
        this.filter.frequency.value = settings.filterFreq;
        this.filter.Q.value = settings.filterQ;

        // Connect Chain
        this.filter.connect(this.ampEnv);
        this.ampEnv.connect(tremGain);
        tremGain.connect(this.pan);
        this.pan.connect(this.dest); // Connect to Main Mix

        // Oscillators
        this.oscillators = [];
        for (let i = 1; i <= 3; i++) {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            
            osc.type = waveforms[settings[`osc${i}_waveform`]];
            osc.frequency.value = freq;
            
            const oct = settings[`osc${i}_octave`];
            const semi = settings[`osc${i}_semi`];
            const fine = settings[`osc${i}_detune`];
            const totalCents = (oct * 1200) + (semi * 100) + fine;
            
            osc.detune.value = totalCents;
            gain.gain.value = settings[`osc${i}_gain`];
            
            osc.connect(gain);
            gain.connect(this.filter);
            osc.start(now);
            
            this.oscillators.push(osc);
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
        const baseF = settings.filterFreq;
        const amt = settings.filterEnvAmt;
        
        this.filter.frequency.cancelScheduledValues(now);
        this.filter.frequency.setValueAtTime(baseF, now);
        this.filter.frequency.linearRampToValueAtTime(baseF + amt, now + fa);
        const sustF = baseF + (amt * fs);
        this.filter.frequency.linearRampToValueAtTime(sustF, now + fa + fd);
    }

    release() {
        if (!this.active) return;
        this.active = false;
        const now = this.ctx.currentTime;
        const r = Math.max(0.001, settings.release);
        const fr = Math.max(0.001, settings.f_release);

        // Amp Release
        if (this.ampEnv) {
            this.ampEnv.gain.cancelScheduledValues(now);
            this.ampEnv.gain.setValueAtTime(this.ampEnv.gain.value, now);
            this.ampEnv.gain.linearRampToValueAtTime(0, now + r);
        }

        // Filter Release
        if (this.filter) {
            this.filter.frequency.cancelScheduledValues(now);
            this.filter.frequency.setValueAtTime(this.filter.frequency.value, now);
            this.filter.frequency.linearRampToValueAtTime(settings.filterFreq, now + fr);
        }

        // Stop Oscs
        const stopTime = now + r + 0.1;
        this.oscillators.forEach(osc => osc.stop(stopTime));
        if (this.tremolo.osc) this.tremolo.osc.stop(stopTime);

        // Cleanup
        setTimeout(() => {
            this.disconnect();
        }, (r + 0.2) * 1000);
    }

    disconnect() {
        // Cleanup nodes
        this.oscillators.forEach(o => { try { o.disconnect(); } catch(e){} });
        if (this.filter) { try { this.filter.disconnect(); } catch(e){} }
        if (this.ampEnv) { try { this.ampEnv.disconnect(); } catch(e){} }
        if (this.pan) { try { this.pan.disconnect(); } catch(e){} }
        if (this.tremolo.osc) { try { this.tremolo.osc.disconnect(); } catch(e){} }
        if (this.tremolo.gain) { try { this.tremolo.gain.disconnect(); } catch(e){} }
        this.note = null;
    }
    
    updateParams(param, value) {
        if (!this.active) return;
        const now = this.ctx.currentTime;
        
        // Simplified live tweaking for performance
        if (param === 'filterFreq' && this.filter) {
             // Only update if envelope isn't dominant? Hard to say.
             // Let's just target.
             this.filter.frequency.setTargetAtTime(value, now, 0.1);
        }
        if (param === 'filterQ' && this.filter) {
             this.filter.Q.setTargetAtTime(value, now, 0.1);
        }
        if (param === 'tremRate' && this.tremolo.osc) {
             this.tremolo.osc.frequency.setTargetAtTime(value, now, 0.1);
        }
    }
}

// Global Audio State
let masterGainNode = null;
let activeVoices = new Map(); // Key: noteNum, Value: SynthVoice instance

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
    paramMap[`osc${i}_gain`] = { min: 0, max: 1, step: 0.01, type: 'dial' };
}

document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    initUI();
    initMidi();
    setupEventListeners();
    
    document.body.addEventListener('click', () => {
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    }, { once: true });
});

function initAudio() {
    if (!audioCtx) {
        audioCtx = new AudioContext();
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
    const select = document.getElementById('midi-device');
    
    // Save current selection
    const current = select.value;
    
    select.innerHTML = '<option value="-1">No MIDI Device</option>';
    
    for (let input of inputs.values()) {
        const opt = document.createElement('option');
        opt.value = input.id;
        opt.text = input.name;
        select.appendChild(opt);
    }
    
    // Restore selection if still valid
    if (Array.from(select.options).some(opt => opt.value === current)) {
        select.value = current;
    } else if (inputs.size > 0) {
        // Auto select first device if none selected
        select.selectedIndex = 1; 
        selectMidiDevice(select.value);
    }
}

function selectMidiDevice(id) {
    // Unhook old
    if (midiInput) {
        midiInput.onmidimessage = null;
    }
    
    if (id === "-1") {
        midiInput = null;
        selectedMidiDevice = "-1";
        return;
    }

    const inputs = midiAccess.inputs;
    for (let input of inputs.values()) {
        if (input.id === id) {
            midiInput = input;
            midiInput.onmidimessage = onMidiMessage;
            selectedMidiDevice = id;
            break;
        }
    }
}

function onMidiMessage(event) {
    const [status, data1, data2] = event.data;
    const command = status & 0xf0;
    const channel = status & 0x0f;
    
    // Filter Channel
    if (selectedMidiChannel !== -1 && channel !== selectedMidiChannel) return;
    
    if (command === 144) { // Note On
        if (data2 > 0) {
            noteOn(data1, data2);
        } else {
            noteOff(data1);
        }
    } else if (command === 128) { // Note Off
        noteOff(data1);
    }
}

// --- Setup Listeners ---
function setupEventListeners() {
    // MIDI UI
    document.getElementById('midi-device').addEventListener('change', (e) => {
        selectMidiDevice(e.target.value);
    });
    
    document.getElementById('midi-channel').addEventListener('change', (e) => {
        selectedMidiChannel = parseInt(e.target.value);
    });

    // Existing Listeners
    document.querySelectorAll('.dial').forEach(dial => {
        dial.addEventListener('mousedown', handleDialStart);
    });

    document.querySelectorAll('input, select').forEach(el => {
        if (el.id.startsWith('midi')) return; // Skip midi controls for standard param map
        
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
    playBtn.addEventListener('mousedown', () => startNoteSequence()); // Mouse Gate
    playBtn.addEventListener('mouseup', () => stopNoteSequence());
    playBtn.addEventListener('mouseleave', () => { if (isPlaying) stopNoteSequence(); });
    
    playBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startNoteSequence(); });
    playBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopNoteSequence(); });

    document.getElementById('randomize-btn').addEventListener('click', randomizeSettings);
    document.getElementById('reset-btn').addEventListener('click', resetSettings);
}

// --- Polyphonic Note Logic ---

// Note On (Polyphonic)
function noteOn(noteNum, velocity = 127) {
    initAudio();
    
    // Voice Stealing / Limiting
    if (activeVoices.size >= MAX_VOICES) {
        // Steal the oldest voice (first key in iterator)
        const firstNote = activeVoices.keys().next().value;
        const oldVoice = activeVoices.get(firstNote);
        oldVoice.release();
        activeVoices.delete(firstNote);
    }

    // Frequency Calculation
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

function killAllVoices() {
    activeVoices.forEach(v => v.disconnect());
    activeVoices.clear();
}

// --- Arp / Mouse Interaction Shim ---
// The ARP logic was designed for a single voice. Let's adapt it to trigger `noteOn/noteOff`.

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
    
    // If ARP, we might have a lingering note
    // If Single Note, release C4
    if (activeVoices.has(60) && !settings.arpEnabled) {
        noteOff(60);
    } else {
        // For ARP, we don't know exactly which note is playing without tracking state specifically
        // Easiest: Release all voices initiated by the ARP.
        // But wait, `noteOn` adds to `activeVoices`. 
        // We should just release all active voices if we want a hard stop, or track the last arp note.
        // Let's release all for safety on stop.
        // Or better, track `lastArpNote`.
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
        // Switch to sustained C4?
        noteOn(60, 127);
    } else if (isPlaying && settings.arpEnabled && arpInterval) {
        clearInterval(arpInterval);
        startArp();
    }
}

// --- Global Parameter Updates ---
function updateAudioParams(param, value) {
    // Update master gain
    if (param === 'volume' && masterGainNode) {
        masterGainNode.gain.setTargetAtTime(value, audioCtx.currentTime, 0.01);
    }
    
    // Update all active voices
    activeVoices.forEach(voice => {
        voice.updateParams(param, value);
    });
}

// --- Helpers (Dial, UI, Settings) ---
// (Need to copy these back in as they were overwritten by the write tool, 
// but since I used 'write' I provided the full file.
// I will include the previous helpers here.)

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

// Dial Logic
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
