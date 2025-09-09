import { AudioFrame, AudioSource, AudioStream, AudioTrack, LocalAudioTrack, RemoteTrack, Room, TrackKind, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import Softphone from "ringcentral-softphone"
import OutboundCallSession from "ringcentral-softphone/call-session/outbound";
import { SoftPhoneOptions } from "ringcentral-softphone/types";
import waitFor from "wait-for-async";
import { sendLivekitAudioStreamToCallSession } from "./utils";

export enum RingCentralLiveKitConnectorCallStatus {
    ANSWERED = 'answered',
    BUSY = 'busy',
    DISPOSED = 'disposed'
}

export class RingCentralLiveKitConnector {
    softphone: Softphone;
    softphoneConnected: boolean = false;
    sampleRate: number = 16000;
    channels: number = 1;

    constructor(softphoneConfig: SoftPhoneOptions, private livekitURL: string) {
        this.softphone = new Softphone(softphoneConfig);
        this.softphone.register()
    }

    async inviteUserToRoom(phoneNumber: string, token: string, options?: {listeningParticipantIdentity?: string, onCallStatusChange?: (status: string) => void}): Promise<OutboundCallSession> {
        if (!this.softphoneConnected) {
            await waitFor({ interval: 100, condition: () => this.softphoneConnected });
        }

        const callSession = await this.softphone.call(phoneNumber)
        const room = new Room()
        const source = new AudioSource(16000, 1)
        const track = LocalAudioTrack.createAudioTrack(`track-${Date.now()}`, source)
        const publishOptions = new TrackPublishOptions()
        publishOptions.source = TrackSource.SOURCE_MICROPHONE

        await room.connect(this.livekitURL, token, {
            autoSubscribe: true,
            dynacast: true,
        })

        await room.localParticipant?.publishTrack(track, publishOptions);

        let callEnded = false;
        (callSession as any).once("answered", () => {
            options?.onCallStatusChange?.(RingCentralLiveKitConnectorCallStatus.ANSWERED)
        });

        (callSession as any).once("busy", () => {
            options?.onCallStatusChange?.(RingCentralLiveKitConnectorCallStatus.BUSY)
            callEnded = true
        });

        (callSession as any).once("disposed", () => {
            options?.onCallStatusChange?.(RingCentralLiveKitConnectorCallStatus.DISPOSED)
            callEnded = true
        });
        
        (callSession as any).on("audioPacket", (rtpPacket: any) => {
            try {
                const encoded = new Uint8Array(rtpPacket.payload.buffer, rtpPacket.payload.byteOffset, rtpPacket.payload.byteLength)
                const pcm = callSession.decoder.decode(encoded)
                const pcmSamples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / Int16Array.BYTES_PER_ELEMENT)

                source.captureFrame(new AudioFrame(pcmSamples, this.sampleRate, this.channels, pcmSamples.length))
            } catch (error) {
                console.error("Failed to capture frame", error)
            }
        })

        room.on("trackSubscribed", (track: RemoteTrack, _publication, participant) => {
            if (
                track.kind === TrackKind.KIND_AUDIO &&
                (options?.listeningParticipantIdentity
                    ? participant.identity === options.listeningParticipantIdentity
                    : true
                )
            ) {
                const audioStream = new AudioStream(track, this.sampleRate, this.channels)

                sendLivekitAudioStreamToCallSession({ audioStream, callSession, callEnded })
            }  
        })

        return callSession
    }
}