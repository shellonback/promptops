import { Injectable, inject, signal, computed, effect } from '@angular/core';
import { Store } from '@ngrx/store';
import { SessionService } from '@/app/views/admin-core/sessions/services/session.service';
import { VoiceCommandRouterService, RouteResult } from '@/app/core/services/voice-command-router.service';
import { SupportedLang } from '@/app/components/voice-agent/voice-commands-data';

export type VoiceState = 'idle' | 'listening' | 'processing';

export interface VoiceResult {
  transcript: string;
  intent: 'navigate_sessions' | 'open_session' | 'terminal_command' | 'unknown';
  confidence: number;
  param?: string;
}

export type PendingActionType = 'session.close' | 'prompt.run';

export interface MicPermissionGuide {
  title: string;
  steps: string[];
  action: string | null;
  settingsUrl: string | null;
}

export interface VoiceCaptureResult {
  ok: boolean;
  text?: string;
  detectedLang?: SupportedLang | null;
  /** 'busy' = another mic is capturing; 'mic-denied' = permission flow already surfaced. */
  error?: string;
  /** Nothing usable captured: silence, or a filtered Whisper hallucination. */
  noSpeech?: boolean;
  /** Peak mic level measured — near 0 with noSpeech means a mute mic. */
  peak?: number;
}

/**
 * Whisper's classic hallucinations on silence/noise — full-transcript matches
 * only (anchored), so real dictation containing these words is never dropped.
 * Without this guard a cough can become "apri <qualcosa>".
 */
const WHISPER_HALLUCINATION_RE: RegExp[] = [
  /^[.,;:!?…\-–—'"\s]*$/,
  /^sottotitoli( e revisione)?\b.{0,40}$/i,
  /^(sottotitoli )?a cura di .{0,30}$/i,
  /^grazie per aver guardato.{0,20}$/i,
  /^grazie\.?$/i,
  /^thanks? (you )?for watching.{0,20}$/i,
  /^please subscribe.{0,20}$/i,
  /^subtitles? by .{0,30}$/i,
  /^.{0,20}amara\.org.{0,20}$/i,
  /^\[.{1,30}\]$/,
  /^\(.{1,30}\)$/,
  /^(♪|♫|#).*$/,
];

@Injectable({ providedIn: 'root' })
export class VoiceAgentService {
  private store = inject(Store);
  private sessionService = inject(SessionService);
  private commandRouter = inject(VoiceCommandRouterService);

  state = signal<VoiceState>('idle');
  lastResult = signal<VoiceResult | null>(null);
  feedback = signal<string>('');
  /** Last raw transcript Whisper produced — surfaced in the UI so the user
   *  can see exactly what was heard. Auto-cleared with the feedback. */
  lastHeard = signal<string>('');
  showConfirm = signal(false);
  pendingCommand = signal<string>('');
  pendingActionType = signal<PendingActionType | null>(null);
  pendingActionData = signal<any>(null);
  openHelpRequest = signal<number>(0);
  micDenied = signal(false);
  micGuide = signal<MicPermissionGuide | null>(null);
  lastDetectedLang = signal<SupportedLang | null>(null);

  /** Minimal-UI dock state, per context: the liquid orb always starts
   *  MINIMIZED in the bottom bar when the app opens (in sessions it is not
   *  restored from localStorage) and can be expanded (fixed top center).
   *  Outside sessions the choice is persisted (see DOCK_STATE_KEY). */
  dockExpandedInSession = signal(false);
  dockExpandedElsewhere = signal(this.readDockPref('other', false));

  private static readonly DOCK_STATE_KEY = 'promptops_voice_dock';

  private readDockPref(key: 'session' | 'other', fallback: boolean): boolean {
    try {
      const raw = localStorage.getItem(VoiceAgentService.DOCK_STATE_KEY);
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return typeof v?.[key] === 'boolean' ? v[key] : fallback;
    } catch {
      return fallback;
    }
  }

  private hotkeyUnsubscribe: (() => void) | null = null;

  constructor() {
    this.initHotkeyListener();
    // Persist the dock state on every change (both contexts in one key).
    effect(() => {
      const v = { session: this.dockExpandedInSession(), other: this.dockExpandedElsewhere() };
      try { localStorage.setItem(VoiceAgentService.DOCK_STATE_KEY, JSON.stringify(v)); } catch { /* ignore */ }
    });
  }

  /** Registers a listener for the global push-to-talk hotkey. Idempotent. */
  private initHotkeyListener(): void {
    const api = (window as any).promptops;
    if (!api?.onVoiceHotkeyToggle || this.hotkeyUnsubscribe) return;
    this.hotkeyUnsubscribe = api.onVoiceHotkeyToggle(() => {
      // Toggle: if idle, start; if listening, stop
      if (this.state() === 'idle') void this.startListening();
      else this.stopListening();
    });
  }

  get isListening() {
    return computed(() => this.state() === 'listening');
  }

  // ── VAD constants ──────────────────────────────────────────────
  /** Absolute floor for the adaptive speech threshold. */
  private readonly VAD_MIN_SPEECH_THRESHOLD = 0.009;
  /** Below this peak the capture is considered a MUTE mic (TCC/device issue),
   *  above it we transcribe even if the frame-level VAD never fired (quiet
   *  mics with low input gain speak under the threshold). */
  private readonly VAD_MUTE_PEAK = 0.005;
  /** Speech threshold = max(MIN, noiseFloor × this factor). */
  private readonly VAD_NOISE_FACTOR = 3;
  /** Hang time of silence after speech before we stop recording. */
  private readonly VAD_TRAILING_SILENCE_MS = 1100;
  /** Hard cap so a runaway mic can't capture forever. Generous enough for
   *  dictated prompts ("invia …"), which 12s kept truncating. */
  private readonly VAD_MAX_RECORD_MS = 30000;
  /** If no speech is detected at all in this window, abort with "no speech". */
  private readonly VAD_NO_SPEECH_TIMEOUT_MS = 5000;
  /** Audio kept before the first detected speech frame. Generous on purpose:
   *  macOS AGC ramps the input gain over ~0.5s, so the first syllable sits
   *  under the VAD threshold and detection lands mid-word — a short pre-roll
   *  clipped "apri" into "pri". */
  private readonly VAD_PRE_ROLL_MS = 800;
  /** Only trim leading silence when it exceeds this much — for the typical
   *  1-2s of lead-in the inference saving is negligible, the clipping risk isn't. */
  private readonly VAD_TRIM_MIN_LEAD_MS = 2500;

  // VAD runtime state
  private vadStream: MediaStream | null = null;
  private vadCtx: AudioContext | null = null;
  private vadProcessor: ScriptProcessorNode | null = null;
  private vadSamples: Float32Array[] = [];
  private vadSampleRate = 16000;
  private vadHadSpeech = false;
  private vadSilenceStart = 0;
  private vadStartedAt = 0;
  private vadHardStopTimer: any = null;
  private vadStopResolve: (() => void) | null = null;
  /** Rolling estimate of the ambient noise RMS (EMA while below threshold). */
  private vadNoiseFloor = 0.006;
  private vadTotalSamples = 0;
  private vadSpeechStartSample = 0;
  /** Highest frame RMS seen in this capture — tells silence from quiet speech. */
  private vadMaxRms = 0;

  /** True while any mic (dock orb, bottom-bar, composer dictation) captures. */
  private captureBusy = false;

  /**
   * Dock flow: capture, transcribe, then ROUTE the transcript as a command.
   */
  async startListening(): Promise<void> {
    if (this.state() !== 'idle') return;

    this.feedback.set('');
    this.lastResult.set(null);

    const res = await this.captureAndTranscribe({ onState: (s) => this.state.set(s) });

    if (!res.ok) {
      this.state.set('idle');
      if (res.error === 'mic-denied' || res.error === 'busy') return; // modal shown / other mic active
      if (res.noSpeech) {
        const lvl = res.peak;
        this.setFeedbackEphemeral(
          lvl === undefined
            ? 'No speech detected.'
            : `No speech detected (mic level ${lvl.toFixed(3)}). ` +
              (lvl < this.VAD_MUTE_PEAK ? 'Microphone muted? Check macOS permissions and the input device.' : ''),
        );
        return;
      }
      if (res.error) this.setFeedbackEphemeral(res.error);
      return;
    }

    await this.processTranscript(res.text!, 0.85, res.detectedLang ?? null);
  }

  /**
   * Hardened capture + transcription shared by EVERY mic in the app:
   * adaptive VAD, ctx.resume, anti-clipping pre-roll, gain normalization,
   * UI-language hint, Whisper hallucination filter. One capture at a time.
   * Does NOT route the transcript — callers decide (command vs dictation).
   */
  async captureAndTranscribe(opts: {
    trailingSilenceMs?: number;
    maxRecordMs?: number;
    onState?: (s: VoiceState) => void;
  } = {}): Promise<VoiceCaptureResult> {
    const onState = opts.onState ?? (() => undefined);
    const api = (window as any).promptops;
    if (!api?.transcribeVoice) return { ok: false, error: 'Available only in the desktop app.' };
    if (this.captureBusy) return { ok: false, error: 'busy' };

    if (api.checkMicPermission) {
      try {
        const mic = await api.checkMicPermission();
        if (!mic.granted) {
          this.micGuide.set(mic.guide);
          this.micDenied.set(true);
          return { ok: false, error: 'mic-denied' };
        }
      } catch { /* proceed anyway if check fails */ }
    }

    this.captureBusy = true;
    try {
      try {
        await this.runVadCapture(
          opts.trailingSilenceMs ?? this.VAD_TRAILING_SILENCE_MS,
          opts.maxRecordMs ?? this.VAD_MAX_RECORD_MS,
          onState,
        );
      } catch (err: any) {
        this.cleanupVad();
        const msg = (err?.message || '').toLowerCase();
        if (msg.includes('permission') || msg.includes('denied') || msg.includes('not allowed')) {
          this.showMicGuideForPlatform();
          return { ok: false, error: 'mic-denied' };
        }
        return { ok: false, error: 'Microphone error: ' + (err?.message || 'unknown') };
      }
      onState('processing');
      return await this.assembleAndTranscribe();
    } finally {
      this.captureBusy = false;
    }
  }

  /** Stops an in-flight capture (any mic); transcription of the recorded audio follows. */
  stopCapture(): void {
    this.stopVad();
  }

  /** Opens the mic and runs the adaptive VAD until silence, cap, or stopCapture(). */
  private async runVadCapture(
    trailingSilenceMs: number,
    maxRecordMs: number,
    onState: (s: VoiceState) => void,
  ): Promise<void> {
    {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      this.vadStream = stream;
      this.vadSamples = [];
      this.vadHadSpeech = false;
      this.vadSilenceStart = 0;
      this.vadStartedAt = Date.now();
      this.vadNoiseFloor = 0.006;
      this.vadTotalSamples = 0;
      this.vadSpeechStartSample = 0;
      this.vadMaxRms = 0;

      // Device-native rate + OfflineAudioContext resample to 16k afterwards.
      // Do NOT request a 16kHz AudioContext here: WKWebView accepts it but
      // createMediaStreamSource on a non-native rate produces garbage/silence
      // (Whisper then "hears" noise and returns "."). The offline resample
      // costs single-digit ms — not worth the breakage.
      const ctx = new AudioContext();
      // WebKit can hand the context out 'suspended' when the transient user
      // activation expired (hotkey path, or the await above) — no frames would
      // ever reach the processor. resume() is a no-op when already running.
      if (ctx.state !== 'running') {
        try { await ctx.resume(); } catch { /* keep going, diagnostics below */ }
      }
      const track = stream.getAudioTracks()[0];
      this.debugLog(`capture open: ctx=${ctx.state} rate=${ctx.sampleRate} track="${track?.label}" muted=${track?.muted} enabled=${track?.enabled} ready=${track?.readyState}`);
      track?.addEventListener?.('mute', () => this.debugLog('mic track MUTED by system'));
      this.vadCtx = ctx;
      this.vadSampleRate = ctx.sampleRate;
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      this.vadProcessor = processor;

      processor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        this.vadSamples.push(new Float32Array(data));
        this.vadTotalSamples += data.length;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        if (rms > this.vadMaxRms) this.vadMaxRms = rms;
        const now = Date.now();
        // Adaptive threshold: in a noisy room the floor rises so breathing/hum
        // doesn't hold the recording open forever; on a quiet mic it converges
        // down to the absolute minimum.
        const speechThreshold = Math.max(this.VAD_MIN_SPEECH_THRESHOLD, this.vadNoiseFloor * this.VAD_NOISE_FACTOR);
        if (rms > speechThreshold) {
          if (!this.vadHadSpeech) this.vadSpeechStartSample = this.vadTotalSamples - data.length;
          this.vadHadSpeech = true;
          this.vadSilenceStart = 0;
        } else {
          this.vadNoiseFloor = this.vadNoiseFloor * 0.95 + rms * 0.05;
          if (this.vadHadSpeech) {
            if (!this.vadSilenceStart) this.vadSilenceStart = now;
            else if (now - this.vadSilenceStart > trailingSilenceMs) {
              this.stopVad();
            }
          } else if (now - this.vadStartedAt > this.VAD_NO_SPEECH_TIMEOUT_MS) {
            // Never spoke at all — abort to avoid a long silent capture.
            this.stopVad();
          }
        }
      };

      source.connect(processor);
      processor.connect(ctx.destination);
      onState('listening');

      // Hard safety cap
      this.vadHardStopTimer = setTimeout(() => this.stopVad(), maxRecordMs);

      // Wait until VAD signals stop (silence, cap, or stopCapture)
      await new Promise<void>((resolve) => { this.vadStopResolve = resolve; });
    }
  }

  /** Stops the VAD pipeline and resolves the listening promise. */
  private stopVad(): void {
    if (this.vadHardStopTimer) { clearTimeout(this.vadHardStopTimer); this.vadHardStopTimer = null; }
    try { this.vadProcessor?.disconnect(); } catch { /* ignore */ }
    try { this.vadCtx?.close().catch(() => undefined); } catch { /* ignore */ }
    try { this.vadStream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    this.vadProcessor = null;
    this.vadCtx = null;
    this.vadStream = null;
    if (this.vadStopResolve) {
      const r = this.vadStopResolve;
      this.vadStopResolve = null;
      r();
    }
  }

  private cleanupVad(): void {
    this.stopVad();
    this.vadSamples = [];
    this.vadHadSpeech = false;
    this.vadSilenceStart = 0;
  }

  /** Assemble the captured PCM, encode 16kHz WAV, transcribe. No routing. */
  private async assembleAndTranscribe(): Promise<VoiceCaptureResult> {
    const peak = this.vadMaxRms;
    if (!this.vadHadSpeech || this.vadSamples.length === 0) {
      // The frame-level VAD never fired. On a quiet mic (low input gain) real
      // speech can sit under the threshold: if the capture has SOME energy,
      // transcribe it anyway instead of dropping it. A truly flat capture is a
      // mute mic (permission/device) — report the measured level.
      if (this.vadSamples.length > 0 && peak >= this.VAD_MUTE_PEAK) {
        console.info('[voice] sub-threshold capture, transcribing anyway', { peak: +peak.toFixed(4) });
        this.vadSpeechStartSample = 0;
      } else {
        this.debugLog(`no-speech abort: peak=${peak.toFixed(4)} chunks=${this.vadSamples.length} samples=${this.vadTotalSamples} floor=${this.vadNoiseFloor.toFixed(4)}`);
        this.cleanupVad();
        return { ok: false, noSpeech: true, peak };
      }
    }

    const totalLen = this.vadSamples.reduce((acc, c) => acc + c.length, 0);
    const sr = this.vadSampleRate;
    const joined = new Float32Array(totalLen);
    let off = 0;
    for (const c of this.vadSamples) { joined.set(c, off); off += c.length; }
    // Drop leading silence ONLY when it's long (user idled before speaking),
    // and always keep a wide pre-roll: aggressive trimming clipped the first
    // syllable of the command.
    const preRoll = Math.floor(sr * this.VAD_PRE_ROLL_MS / 1000);
    const minLead = Math.floor(sr * this.VAD_TRIM_MIN_LEAD_MS / 1000);
    const startAt = this.vadSpeechStartSample > minLead
      ? Math.max(0, this.vadSpeechStartSample - preRoll)
      : 0;
    const all = startAt > 0 ? joined.subarray(startAt) : joined;
    this.cleanupVad();

    const TARGET_SR = 16000;
    let final: Float32Array;
    if (sr !== TARGET_SR) {
      try {
        const offline = new OfflineAudioContext(1, Math.ceil(all.length * TARGET_SR / sr), TARGET_SR);
        const buf = offline.createBuffer(1, all.length, sr);
        buf.getChannelData(0).set(all);
        const src = offline.createBufferSource();
        src.buffer = buf;
        src.connect(offline.destination);
        src.start();
        const rendered = await offline.startRendering();
        final = rendered.getChannelData(0);
      } catch {
        final = all;
      }
    } else {
      final = all;
    }

    // Capture diagnostics: seconds sent + sample peak. A peak near 0 with a
    // non-empty transcript means the mic pipeline is feeding garbage.
    let samplePeak = 0;
    for (let i = 0; i < final.length; i++) { const a = Math.abs(final[i]); if (a > samplePeak) samplePeak = a; }
    // Quiet captures (soft voice / mic far away) degrade Whisper badly —
    // normalize the gain up to a sane peak before encoding.
    if (samplePeak > 0.001 && samplePeak < 0.5) {
      const gain = Math.min(0.9 / samplePeak, 8);
      for (let i = 0; i < final.length; i++) final[i] *= gain;
    }
    const captureStats = `capture: sec=${(final.length / TARGET_SR).toFixed(2)} peak=${samplePeak.toFixed(3)} rmsPeak=${peak.toFixed(3)} deviceRate=${sr} trimmedSec=${(startAt / sr).toFixed(2)}`;
    console.info('[voice] ' + captureStats);
    this.debugLog(captureStats);

    const wav = this.encodePcmToWav(final, TARGET_SR);
    const bytes = new Uint8Array(wav);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length)) as any);
    }
    const base64 = btoa(bin);

    const api = (window as any).promptops;
    try {
      // UI language as explicit hint: auto-detection on 2-3s clips is a coin
      // flip ("apri le sessioni" decoded as "This is Sioni" in EN). Whisper
      // with a language hint decodes directly in that language.
      const uiLang = (localStorage.getItem('promptops_lang') || '').toLowerCase();
      const lang = (['it', 'en', 'es', 'fr', 'pt'] as string[]).includes(uiLang) ? uiLang : 'auto';
      const result = await api.transcribeVoice({ lang, audioBase64: base64, mimeType: 'audio/wav' });
      if (result?.ok && result.text) {
        const text = result.text.trim();
        // Whisper hallucination on silence/noise → not a transcription.
        if (!text || WHISPER_HALLUCINATION_RE.some((re) => re.test(text))) {
          console.info('[voice] hallucination filtered', { text });
          return { ok: false, noSpeech: true };
        }
        const detected = (result.detectedLang ?? null) as SupportedLang | null;
        this.lastDetectedLang.set(detected);
        console.info('[voice] transcript', { text, lang: detected, engine: result.engine });
        return { ok: true, text, detectedLang: detected, peak };
      }
      console.warn('[voice] transcribe failed', { error: result?.error, raw: result });
      return { ok: false, error: result?.error || 'Transcription failed.' };
    } catch (err: any) {
      return { ok: false, error: 'Error: ' + (err?.message || 'unknown') };
    }
  }

  /** Minimal 16-bit mono PCM WAV encoder. */
  private encodePcmToWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true);  // PCM format
    view.setUint16(22, 1, true);  // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
    return buffer;
  }

  /** Title and steps are translation keys; the mic modal renders them with the translate pipe. */
  private showMicGuideForPlatform(): void {
    const isWin = navigator.userAgent.includes('Windows');
    const isMac = navigator.userAgent.includes('Macintosh');

    const guide: MicPermissionGuide = isMac ? {
      title: 'VOICE.Mic access title',
      steps: [
        'VOICE.MIC_GUIDE.mac1',
        'VOICE.MIC_GUIDE.mac2',
        'VOICE.MIC_GUIDE.mac3',
        'VOICE.MIC_GUIDE.mac4',
      ],
      action: 'open-settings',
      settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    } : isWin ? {
      title: 'VOICE.Mic access title',
      steps: [
        'VOICE.MIC_GUIDE.win1',
        'VOICE.MIC_GUIDE.win2',
        'VOICE.MIC_GUIDE.win3',
        'VOICE.MIC_GUIDE.win4',
      ],
      action: 'open-settings',
      settingsUrl: 'ms-settings:privacy-microphone',
    } : {
      title: 'VOICE.Mic access title',
      steps: [
        'VOICE.MIC_GUIDE.linux1',
        'VOICE.MIC_GUIDE.linux2',
        'VOICE.MIC_GUIDE.linux3',
        'VOICE.MIC_GUIDE.linux4',
      ],
      action: null,
      settingsUrl: null,
    };

    this.micGuide.set(guide);
    this.micDenied.set(true);
  }

  dismissMicModal(): void {
    this.micDenied.set(false);
    this.micGuide.set(null);
  }

  async openMicSettings(): Promise<void> {
    const api = (window as any).promptops;
    if (api?.openMicSettings) {
      await api.openMicSettings();
    }
    this.dismissMicModal();
  }

  stopListening(): void {
    // If we are in the middle of a VAD capture, stop it (this triggers the
    // transcription path with whatever has been recorded so far).
    if (this.vadStream) {
      this.stopVad();
      return;
    }
    this.state.set('idle');
  }

  confirmDangerous(): void {
    const type = this.pendingActionType();
    const data = this.pendingActionData();
    const cmd = this.pendingCommand();
    if (type === 'session.close' && data?.sessionId) {
      // Destroy the active session via main process
      const api = (window as any).promptops;
      if (api?.destroySession) api.destroySession(data.sessionId).catch(() => undefined);
      this.clearPending();
      this.setFeedbackEphemeral('Session closed.');
      // The mic stayed in 'processing' after this branch and ignored every
      // click until the app was reloaded.
      this.state.set('idle');
    } else if (type === 'prompt.run' && data?.cmd) {
      this.clearPending();
      const api = (window as any).promptops;
      if (data.target?.type === 'subagent' && api?.writeSubAgent) {
        // Confirmed on the agent that had the focus when it was spoken.
        api.writeSubAgent(data.target.id, data.cmd + '\n').catch(() => undefined);
        this.feedback.set(`Executed: ${data.cmd}`);
        setTimeout(() => this.state.set('idle'), 1500);
      } else {
        this.injectTerminalCommand(data.cmd, data.target?.type === 'session' ? data.target.id : null);
      }
    } else if (cmd) {
      // Legacy path
      this.clearPending();
      this.injectTerminalCommand(cmd);
    } else {
      this.clearPending();
      this.state.set('idle');
    }
  }

  cancelDangerous(): void {
    this.clearPending();
    this.setFeedbackEphemeral('Command canceled.');
    this.state.set('idle');
  }

  private clearPending(): void {
    this.pendingCommand.set('');
    this.pendingActionType.set(null);
    this.pendingActionData.set(null);
    this.showConfirm.set(false);
  }

  // ── Intent Detection (delegates to VoiceCommandRouterService) ────────

  /** Auto-clear timer for the feedback bubble. Canceled if a new message arrives. */
  private feedbackClearTimer: any = null;
  /** How long success/error feedback stays on screen before auto-dismissing. */
  private readonly FEEDBACK_TTL_MS = 5000;

  /** Mirrors webapp voice diagnostics into the Rust terminal log (dev QA):
   *  the WKWebView console is invisible from the dev terminal. */
  private debugLog(msg: string): void {
    try { (window as any).promptops?.debugLog?.('[voice-web] ' + msg); } catch { /* ignore */ }
  }

  private setFeedbackEphemeral(text: string): void {
    this.feedback.set(text);
    if (this.feedbackClearTimer) clearTimeout(this.feedbackClearTimer);
    this.feedbackClearTimer = setTimeout(() => {
      // Don't wipe if a confirmation is now pending — the user must read it.
      if (this.showConfirm()) return;
      this.feedback.set('');
      this.lastResult.set(null);
      this.lastHeard.set('');
    }, this.FEEDBACK_TTL_MS);
  }

  private cancelFeedbackTimer(): void {
    if (this.feedbackClearTimer) { clearTimeout(this.feedbackClearTimer); this.feedbackClearTimer = null; }
  }

  private async processTranscript(transcript: string, confidence: number, detectedLang: SupportedLang | null): Promise<void> {
    this.cancelFeedbackTimer();

    // Whisper hallucination on silence → treat as "no speech", don't route.
    const t = transcript.trim();
    if (!t || WHISPER_HALLUCINATION_RE.some((re) => re.test(t))) {
      console.info('[voice] hallucination filtered', { transcript });
      this.state.set('idle');
      this.setFeedbackEphemeral('No speech detected.');
      return;
    }

    this.feedback.set(`"${transcript}"`);
    this.lastHeard.set(transcript);

    const result: RouteResult = await this.commandRouter.route(transcript, detectedLang);

    if (result.openHelp) {
      this.openHelpRequest.update((n) => n + 1);
      this.setFeedbackEphemeral(result.feedback ?? '');
      setTimeout(() => this.state.set('idle'), 600);
      return;
    }

    if (result.needsConfirmation && result.pending) {
      this.pendingActionType.set(result.pending.type);
      this.pendingActionData.set(result.pending.data);
      // Keep `pendingCommand` populated for backward-compat with existing UI
      this.pendingCommand.set(result.pending.data?.cmd ?? '');
      // Confirmation feedback stays put — user must act, no auto-clear.
      this.feedback.set(result.feedback ?? 'Confirm action');
      this.showConfirm.set(true);
      return;
    }

    if (result.ok) {
      this.lastResult.set({
        transcript,
        intent: this.mapToLegacyIntent(result.intentId),
        confidence,
      });
      if (result.feedback) this.setFeedbackEphemeral(result.feedback);
      setTimeout(() => this.state.set('idle'), 1200);
      return;
    }

    // Unknown / no-match — show what was heard so the user knows whether to
    // re-speak or rephrase. The auto-retry was removed because it kept firing
    // before the user was ready to talk again, capturing silence.
    this.lastResult.set({ transcript, intent: 'unknown', confidence });
    this.setFeedbackEphemeral(`"${transcript}" — not recognized`);
    setTimeout(() => this.state.set('idle'), 2500);
  }

  private mapToLegacyIntent(intentId?: string): VoiceResult['intent'] {
    if (!intentId) return 'unknown';
    if (intentId.startsWith('nav.')) return 'navigate_sessions';
    if (intentId.startsWith('session.')) return 'open_session';
    if (intentId.startsWith('prompt.')) return 'terminal_command';
    return 'unknown';
  }

  private injectTerminalCommand(command: string, sessionId: string | null = null): void {
    let activeId: string | null = sessionId;
    if (!activeId) {
      this.store.select((s: any) => s.sessions?.activeSessionId).subscribe((v) => activeId = v).unsubscribe();
    }

    if (!activeId) {
      this.feedback.set('No active session.');
      setTimeout(() => this.state.set('idle'), 2000);
      return;
    }

    if (!this.sessionService.isDesktop) {
      this.feedback.set('Terminal available only in the desktop app.');
      setTimeout(() => this.state.set('idle'), 2000);
      return;
    }

    this.sessionService.writeSession(activeId, command + '\n');
    this.feedback.set(`Executed: ${command}`);
    setTimeout(() => this.state.set('idle'), 1500);
  }
}
