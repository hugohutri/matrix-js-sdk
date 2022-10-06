/*
Copyright 2021 Šimon Brandner <simon.bra.ag@gmail.com>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { SDPStreamMetadataPurpose } from "./callEventTypes";
import { acquireContext, releaseContext } from "./audioContext";
import { MatrixClient } from "../client";
import { RoomMember } from "../models/room-member";
import { logger } from "../logger";
import { TypedEventEmitter } from "../models/typed-event-emitter";

const POLLING_INTERVAL = 1; // ms
export const SPEAKING_THRESHOLD = -60; // dB
const VAD_THRESHOLD = -100; //dB
const SPEAKING_SAMPLE_COUNT = 8; // samples
const VADCOOLDOWN = 200; // ms

export interface ICallFeedOpts {
    client: MatrixClient;
    roomId: string;
    userId: string;
    stream: MediaStream;
    purpose: SDPStreamMetadataPurpose;
    /**
     * Whether or not the remote SDPStreamMetadata says audio is muted
     */
    audioMuted: boolean;
    /**
     * Whether or not the remote SDPStreamMetadata says video is muted
     */
    videoMuted: boolean;
    /**
     * set the Tracks to muted when volume threshold has not been reached
     * This does not show the user as muted.
     */
    setVoiceActivityDetectionMute?: (muted: boolean) => void;
    VADEnabled?: boolean;
}

export enum CallFeedEvent {
    NewStream = "new_stream",
    MuteStateChanged = "mute_state_changed",
    LocalVolumeChanged = "local_volume_changed",
    VolumeChanged = "volume_changed",
    Speaking = "speaking",
    VoiceActivityThresholdChanged = "voice_activity_threshold_changed",
    VADMuteStateChanged = "vad_mute_state_changed",
}

type EventHandlerMap = {
    [CallFeedEvent.NewStream]: (stream: MediaStream) => void;
    [CallFeedEvent.MuteStateChanged]: (audioMuted: boolean, videoMuted: boolean) => void;
    [CallFeedEvent.LocalVolumeChanged]: (localVolume: number) => void;
    [CallFeedEvent.VolumeChanged]: (volume: number) => void;
    [CallFeedEvent.Speaking]: (speaking: boolean) => void;
    [CallFeedEvent.VoiceActivityThresholdChanged]: (threshold: number) => void;
    [CallFeedEvent.VADMuteStateChanged]: (VADMuted: boolean) => void;
};
export class CallFeed extends TypedEventEmitter<CallFeedEvent, EventHandlerMap> {
    public stream: MediaStream;
    public volumeLooperStream: MediaStream;
    public audioDelay: DelayNode;
    public sdpMetadataStreamId: string;
    public userId: string;
    public purpose: SDPStreamMetadataPurpose;
    public speakingVolumeSamples: number[];
    public voiceActivityThreshold: number;
    public setVoiceActivityDetectionMute: (muted: boolean) => void;
    public VADEnabled = false;
    public maxVolume = -Infinity;

    private client: MatrixClient;
    private roomId: string;
    private audioMuted: boolean;
    private vadAudioMuted: boolean;
    private videoMuted: boolean;
    private localVolume = 1;
    private measuringVolumeActivity = false;
    private audioContext: AudioContext;
    private analyser: AnalyserNode;
    private frequencyBinCount: Float32Array;
    private speakingThreshold = SPEAKING_THRESHOLD;
    private speaking = false;
    private volumeLooperTimeout: ReturnType<typeof setTimeout>;
    /**
     * Cooldown for voice activity detection, so that we don't mute immediately when the user stops speaking
     * But when he has been silent 200ms
     */
    private VADCooldownStarted = new Date();

    constructor(opts: ICallFeedOpts) {
        super();

        this.client = opts.client;
        this.roomId = opts.roomId;
        this.userId = opts.userId;
        this.purpose = opts.purpose;
        this.audioMuted = opts.audioMuted;
        this.videoMuted = opts.videoMuted;
        this.speakingVolumeSamples = new Array(SPEAKING_SAMPLE_COUNT).fill(-Infinity);
        this.sdpMetadataStreamId = opts.stream.id;
        this.voiceActivityThreshold = VAD_THRESHOLD;
        this.setVoiceActivityDetectionMute = opts.setVoiceActivityDetectionMute;

        this.updateStream(null, opts.stream);

        this.VADEnabled = opts.VADEnabled ?? false;

        if (this.hasAudioTrack) {
            this.initVolumeMeasuring();
        }
    }

    public setVoiceActivityThreshold(threshold: number): void {
        this.voiceActivityThreshold = threshold;
        if (threshold === -100) {
            this.VADEnabled = false;
            this.setVoiceActivityDetectionMute?.(false);
        } else {
            this.VADEnabled = true;
        }
    }

    private get hasAudioTrack(): boolean {
        return this.stream.getAudioTracks().length > 0;
    }

    private updateStream(oldStream: MediaStream, newStream: MediaStream): void {
        if (newStream === oldStream) return;

        if (oldStream) {
            oldStream.removeEventListener("addtrack", this.onAddTrack);
            this.measureVolumeActivity(false);
        }
        if (newStream) {
            this.stream = newStream;
            newStream.addEventListener("addtrack", this.onAddTrack);

            if (this.hasAudioTrack) {
                this.initVolumeMeasuring();
            } else {
                this.measureVolumeActivity(false);
            }
        }

        this.emit(CallFeedEvent.NewStream, this.stream);
    }

    private initVolumeMeasuring(): void {
        if (!this.hasAudioTrack) return;
        if (!this.audioContext) this.audioContext = acquireContext();

        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 512;
        this.analyser.smoothingTimeConstant = 0.1;

        this.volumeLooperStream = this.stream.clone();
        const mediaStreamAudioSourceNode = this.audioContext.createMediaStreamSource(this.volumeLooperStream);
        mediaStreamAudioSourceNode.connect(this.analyser);

        const streamNode = this.audioContext.createMediaStreamSource(this.stream);
        this.audioDelay = this.audioContext.createDelay(0.001);
        const gainNode = this.audioContext.createGain();
        streamNode.connect(gainNode);
        gainNode.connect(this.audioDelay);
        const destination = this.audioContext.createMediaStreamDestination();
        this.audioDelay.connect(destination);
        this.stream = destination.stream;

        this.frequencyBinCount = new Float32Array(this.analyser.frequencyBinCount);
    }

    private onAddTrack = (): void => {
        this.emit(CallFeedEvent.NewStream, this.stream);
    };

    /**
     * Returns callRoom member
     * @returns member of the callRoom
     */
    public getMember(): RoomMember {
        const callRoom = this.client.getRoom(this.roomId);
        return callRoom.getMember(this.userId);
    }

    /**
     * Returns true if CallFeed is local, otherwise returns false
     * @returns {boolean} is local?
     */
    public isLocal(): boolean {
        return this.userId === this.client.getUserId();
    }

    /**
     * Returns true if audio is muted or if there are no audio
     * tracks, otherwise returns false
     * @returns {boolean} is audio muted?
     */
    public isAudioMuted(): boolean {
        return this.stream.getAudioTracks().length === 0 || this.audioMuted;
    }

    /**
     * Returns true video is muted or if there are no video
     * tracks, otherwise returns false
     * @returns {boolean} is video muted?
     */
    public isVideoMuted(): boolean {
        // We assume only one video track
        return this.stream.getVideoTracks().length === 0 || this.videoMuted;
    }

    public isSpeaking(): boolean {
        return this.speaking;
    }

    /**
     * Replaces the current MediaStream with a new one.
     * The stream will be different and new stream as remore parties are
     * concerned, but this can be used for convenience locally to set up
     * volume listeners automatically on the new stream etc.
     * @param newStream new stream with which to replace the current one
     */
    public setNewStream(newStream: MediaStream): void {
        this.updateStream(this.stream, newStream);
    }

    /**
     * Set one or both of feed's internal audio and video video mute state
     * Either value may be null to leave it as-is
     * @param muted is the feed's video muted?
     */
    public setAudioVideoMuted(audioMuted: boolean, videoMuted: boolean): void {
        if (audioMuted !== null) {
            if (this.audioMuted !== audioMuted) {
                this.speakingVolumeSamples.fill(-Infinity);
            }
            this.audioMuted = audioMuted;
        }
        if (videoMuted !== null) this.videoMuted = videoMuted;
        this.emit(CallFeedEvent.MuteStateChanged, this.audioMuted, this.videoMuted);
        this.VADEnabled = !audioMuted;
    }

    public setVoiceActivityDetectionMuteLocal(audioMuted: boolean | null, videoMuted: boolean | null): void {
        if (audioMuted !== null) {
            this.vadAudioMuted = audioMuted;
        }
    }

    /**
     * Starts emitting volume_changed events where the emitter value is in decibels
     * @param enabled emit volume changes
     */
    public measureVolumeActivity(enabled: boolean): void {
        if (enabled) {
            if (!this.analyser || !this.frequencyBinCount || !this.hasAudioTrack) return;

            this.measuringVolumeActivity = true;
            this.volumeLooper();
        } else {
            this.measuringVolumeActivity = false;
            this.speakingVolumeSamples.fill(-Infinity);
            this.emit(CallFeedEvent.VolumeChanged, -Infinity);
        }
    }

    public setSpeakingThreshold(threshold: number) {
        this.speakingThreshold = threshold;
    }

    private volumeLooper = () => {
        if (!this.analyser) return;

        if (!this.measuringVolumeActivity) return;

        this.analyser.getFloatFrequencyData(this.frequencyBinCount);

        let maxCurrentVolume = -Infinity;
        for (let i = 0; i < this.frequencyBinCount.length; i++) {
            if (this.frequencyBinCount[i] > maxCurrentVolume) {
                maxCurrentVolume = this.frequencyBinCount[i];
            }
        }
        this.maxVolume = maxCurrentVolume;
        this.speakingVolumeSamples.shift();
        this.speakingVolumeSamples.push(this.maxVolume);

        this.emit(CallFeedEvent.VolumeChanged, this.maxVolume);

        // Handle voice activity detection only if it is enabled and user has not manually muted themselves
        if (this.VADEnabled) {
            // If the user is speaking
            if (this.maxVolume > this.voiceActivityThreshold) {
                this.VADCooldownStarted = new Date();

                if (this.vadAudioMuted) {
                    //this.emit(CallFeedEvent.VADMuteStateChanged, false)
                    this.setVoiceActivityDetectionMute?.(false);
                }
            } else if (!this.vadAudioMuted) {
                // User stops speaking

                if (!this.isVADinCooldown()) {
                    // user has been silent for X milliseconds
                    //this.emit(CallFeedEvent.VADMuteStateChanged, true)
                    this.setVoiceActivityDetectionMute?.(true);
                }
            }
        }

        let newSpeaking = false;

        for (let i = 0; i < this.speakingVolumeSamples.length; i++) {
            const volume = this.speakingVolumeSamples[i];

            if (volume > this.speakingThreshold) {
                newSpeaking = true;
                break;
            }
        }

        if (this.speaking !== newSpeaking) {
            this.speaking = newSpeaking;
            this.emit(CallFeedEvent.Speaking, this.speaking);
        }

        this.volumeLooperTimeout = setTimeout(this.volumeLooper, POLLING_INTERVAL);
    };

    private isVADinCooldown(): boolean {
        return (
            new Date().getTime() - this.VADCooldownStarted.getTime() < VADCOOLDOWN);
    }

    public clone(): CallFeed {
        const mediaHandler = this.client.getMediaHandler();
        const stream = this.stream.clone();
        logger.log(`callFeed cloning stream ${this.stream.id} newStream ${stream.id}`);

        if (this.purpose === SDPStreamMetadataPurpose.Usermedia) {
            mediaHandler.userMediaStreams.push(stream);
        } else {
            mediaHandler.screensharingStreams.push(stream);
        }

        return new CallFeed({
            client: this.client,
            roomId: this.roomId,
            userId: this.userId,
            stream,
            purpose: this.purpose,
            audioMuted: this.audioMuted,
            videoMuted: this.videoMuted,
        });
    }

    public dispose(): void {
        clearTimeout(this.volumeLooperTimeout);
        this.stream?.removeEventListener("addtrack", this.onAddTrack);
        if (this.audioContext) {
            this.audioContext = null;
            this.analyser = null;
            releaseContext();
        }
    }

    public getLocalVolume(): number {
        return this.localVolume;
    }

    public setLocalVolume(localVolume: number): void {
        this.localVolume = localVolume;
        this.emit(CallFeedEvent.LocalVolumeChanged, localVolume);
    }
}
