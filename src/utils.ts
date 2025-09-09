import { AudioStream } from "@livekit/rtc-node";
import OutboundCallSession from "ringcentral-softphone/call-session/outbound";
import { RtpHeader, RtpPacket } from "werift-rtp";

export const randomInt = () =>
    Math.floor(Math.random() * (65535 - 1024 + 1)) + 1024;

const LIVEKIT_FRAME_SIZE = 320 // 20ms at 16kHz = 320 samples
const REQUIRED_BYTES_TO_SEND = LIVEKIT_FRAME_SIZE * 2 // 640 bytes per frame

interface SendLivekitAudioStreamToCallSessionOptions {
    audioStream: AudioStream
    callSession: OutboundCallSession
    callEnded: boolean
}
export const sendLivekitAudioStreamToCallSession = async ({ audioStream, callSession, callEnded }: SendLivekitAudioStreamToCallSessionOptions) => {
    if (!audioStream) {
        console.error('sendLivekitAudioStreamToCallSession:: AudioStream is required')
        return
    }

    if (callSession.disposed) {
        console.error('sendLivekitAudioStreamToCallSession:: Call already ended or disposed, aborting')
        return
    }

    // Memory management constants
    const FRAME_SIZE = REQUIRED_BYTES_TO_SEND // 640 bytes
    const MAX_BUFFER_FRAMES = 5 // Maximum 5 frames in buffer (3.2KB max)
    const MAX_BUFFER_SIZE = FRAME_SIZE * MAX_BUFFER_FRAMES
    const GC_THRESHOLD = 300 // Increased threshold to reduce GC frequency

    // Use pre-allocated buffers to avoid frequent allocations
    let pcmBuffer = Buffer.allocUnsafe(0)
    let frameBuffer = Buffer.allocUnsafe(FRAME_SIZE) // Reusable frame buffer
    let tempBuffer: Buffer[] = [] // Temporary array for concat optimization

    let frameCount = 0
    let totalBytesProcessed = 0
    let gcCount = 0
    let timestamp = Math.floor(Date.now() / 1000);
    let sequenceNumber = timestamp % 65536;

    const ssrc = randomInt()

    try {
        for await (const audioFrame of audioStream as any) {
            // Early exit check
            if (callEnded) {
                console.log('sendLivekitAudioStreamToCallSession:: Call ended, stopping gracefully')
                break
            }

            // Validate frame
            if (!audioFrame?.data?.buffer) {
                console.log('sendLivekitAudioStreamToCallSession:: Invalid audio frame, skipping')
                continue
            }

            frameCount++

            // Extract chunk without additional copying when possible
            const chunkSize = audioFrame.data.byteLength
            const chunk = Buffer.from(audioFrame.data.buffer, audioFrame.data.byteOffset, chunkSize)

            totalBytesProcessed += chunkSize

            // Memory protection: Drop buffer if it grows too large
            if (pcmBuffer.length + chunkSize > MAX_BUFFER_SIZE) {
                console.log(`Buffer overflow protection: dropping ${pcmBuffer.length} bytes to prevent memory issue`)
                pcmBuffer = Buffer.allocUnsafe(0) // Reset buffer
                tempBuffer = [] // Clear temp array
            }

            // Optimized buffer concatenation using temp array
            tempBuffer.push(chunk)

            // Only concat when we have enough data or temp array is getting large
            if (tempBuffer.length > 3 || tempBuffer.reduce((sum, buf) => sum + buf.length, pcmBuffer.length) >= FRAME_SIZE) {
                tempBuffer.unshift(pcmBuffer) // Add current buffer to front
                pcmBuffer = Buffer.concat(tempBuffer)
                tempBuffer = [] // Clear temp array to free references
            }

            while (pcmBuffer.length >= FRAME_SIZE && !callEnded) {
                // Copy frame data to reusable buffer to avoid keeping reference to large buffer
                pcmBuffer.copy(frameBuffer, 0, 0, FRAME_SIZE)

                // Slice off the processed data (creates new buffer view)
                pcmBuffer =
                    pcmBuffer.length === FRAME_SIZE
                        ? Buffer.allocUnsafe(0) // If exact match, allocate new empty buffer
                        : pcmBuffer.subarray(FRAME_SIZE) // Otherwise use subarray (zero-copy)

                try {
                    // Encode using the reusable frame buffer
                    const encodedData = callSession.encoder.encode(frameBuffer)
                    const encodedPacket = Buffer.from(encodedData)

                    // Send packet
                    const rtpPacket = new RtpPacket(
                        new RtpHeader({
                            version: 2,
                            padding: false,
                            paddingSize: 0,
                            extension: false,
                            marker: false,
                            payloadOffset: 12,
                            payloadType: callSession.softphone.codec.id,
                            sequenceNumber,
                            timestamp,
                            ssrc,
                            csrcLength: 0,
                            csrc: [],
                            extensionProfile: 48862,
                            extensions: [],
                        }),
                        encodedPacket
                    )
                    sequenceNumber++
                    if (sequenceNumber > 65535) {
                        sequenceNumber = 0
                    }
                    timestamp += callSession.softphone.codec.timestampInterval

                    callSession.sendPacket(rtpPacket)

                    // Clear reference to encoded data to help GC
                    encodedData.fill(0)
                } catch (err) {
                    console.error('RingcentralRTPService::sendAudioStream:: Opus encoding error:', err as Error)
                    continue
                }
            }
        }
    } catch (error) {
        console.error('sendLivekitAudioStreamToCallSession:: Error:', error as Error)
    } finally {
        // Comprehensive cleanup
        try {
            // Clear all buffer references
            if (pcmBuffer) {
                pcmBuffer.fill(0) // Zero out sensitive audio data
                pcmBuffer = null as any
            }

            if (frameBuffer) {
                frameBuffer.fill(0)
                frameBuffer = null as any
            }

            // Clear temp buffer array
            if (tempBuffer) {
                tempBuffer.forEach((buf) => buf.fill(0))
                tempBuffer = []
            }

            // Force final GC if available
            if (typeof global !== 'undefined' && global?.gc) {
                try {
                    global.gc()
                    console.log('sendLivekitAudioStreamToCallSession:: Final garbage collection performed')
                } catch (gcError) {
                    console.log('sendLivekitAudioStreamToCallSession:: Failed to perform garbage collection:', gcError as Error)
                }
            }

            console.log(
                `sendLivekitAudioStreamToCallSession:: Processing completed: ${frameCount} frames, ${Math.round(totalBytesProcessed / 1024)}KB processed, ${gcCount} GC cycles`
            )
        } catch (cleanupError) {
            console.error('sendLivekitAudioStreamToCallSession:: Error during cleanup:', cleanupError as Error)
        }
        console.log('sendLivekitAudioStreamToCallSession:: Audio stream processing completed')
    }
}