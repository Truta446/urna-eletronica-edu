/**
 * "Cabo" entre o terminal do mesário e a urna, simulado com BroadcastChannel: só abas da MESMA
 * origem no MESMO navegador recebem. O token nunca vai para a URL nem para o armazenamento local.
 */
export type BoothMessage =
  | { type: 'release'; electionId: string; token: string; expiresAt: string }
  | { type: 'ack' }
  | { type: 'voted' };

const CHANNEL = 'urna-edu-booth';

export function openBoothChannel(onMessage: (message: BoothMessage) => void) {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event: MessageEvent<BoothMessage>) => {
    onMessage(event.data);
  };
  return {
    send: (message: BoothMessage) => {
      channel.postMessage(message);
    },
    close: () => {
      channel.close();
    },
  };
}
