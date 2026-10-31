import { VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import type { DiagnosticFields } from './telemetry';

/** Allowlist scalars: never log connection objects, endpoints, keys or tokens. */
export function voiceSnapshot(connection: VoiceConnection): DiagnosticFields {
  const state = connection.state;
  const result: DiagnosticFields = { voiceState: state.status, subscribed: 'subscription' in state && !!state.subscription,
    wsPingMs: connection.ping.ws, udpPingMs: connection.ping.udp };
  if (state.status === VoiceConnectionStatus.Ready) {
    const network = state.networking.state;
    result.networkState = network.code;
    if ('connectionData' in network && 'packetsPlayed' in network.connectionData) {
      result.voicePackets = network.connectionData.packetsPlayed;
      result.voiceSpeaking = network.connectionData.speaking;
      result.encryptionMode = network.connectionData.encryptionMode;
    }
    if ('dave' in network) {
      result.daveVersion = network.dave?.protocolVersion;
      result.daveReinitializing = network.dave?.reinitializing;
      result.daveSession = !!network.dave?.session;
    }
  }
  return result;
}
