"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type ChatMessage = {
  id: number;
  roomId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: number;
};

type SignalMessage = {
  id: number;
  roomId: string;
  senderId: string;
  recipientId: string | null;
  kind: "join" | "offer" | "answer" | "ice" | "leave";
  payload: Record<string, unknown>;
  createdAt: number;
};

type RemotePeer = {
  id: string;
  name: string;
  stream: MediaStream | null;
};

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function makeId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function getInitialRoom() {
  if (typeof window === "undefined") {
    return "sala-amigos";
  }

  const current = new URL(window.location.href);
  const room = current.searchParams.get("room");
  if (room) {
    return room;
  }

  const generated = `sala-${Math.random().toString(36).slice(2, 8)}`;
  current.searchParams.set("room", generated);
  window.history.replaceState(null, "", current);
  return generated;
}

function getStoredName() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem("papo-nome") ?? "";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<T>;
}

export default function Home() {
  const [roomId, setRoomId] = useState(getInitialRoom);
  const [clientId] = useState(() => makeId("pessoa"));
  const [name, setName] = useState(getStoredName);
  const [draftName, setDraftName] = useState(getStoredName);
  const [draftMessage, setDraftMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [status, setStatus] = useState("Entre com camera ou microfone para iniciar.");
  const [error, setError] = useState("");
  const [lastSignalId, setLastSignalId] = useState(0);

  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const knownSignalsRef = useRef<Set<number>>(new Set());

  const roomLink = useMemo(() => {
    if (typeof window === "undefined") {
      return "";
    }

    const url = new URL(window.location.href);
    url.searchParams.set("room", roomId);
    return url.toString();
  }, [roomId]);

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const postSignal = useCallback(
    async (kind: SignalMessage["kind"], payload: Record<string, unknown>, recipientId?: string) => {
      await api<{ ok: boolean }>("/api/signals", {
        method: "POST",
        body: JSON.stringify({
          roomId,
          senderId: clientId,
          recipientId: recipientId ?? null,
          kind,
          payload,
        }),
      });
    },
    [clientId, roomId],
  );

  const createPeer = useCallback(
    (peerId: string, peerName: string) => {
      const current = peersRef.current.get(peerId);
      if (current) {
        return current;
      }

      const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peersRef.current.set(peerId, peer);
      setRemotePeers((items) => {
        if (items.some((item) => item.id === peerId)) {
          return items;
        }
        return [...items, { id: peerId, name: peerName, stream: null }];
      });

      localStreamRef.current?.getTracks().forEach((track) => {
        peer.addTrack(track, localStreamRef.current as MediaStream);
      });

      peer.ontrack = (event) => {
        const [stream] = event.streams;
        setRemotePeers((items) =>
          items.map((item) => (item.id === peerId ? { ...item, stream, name: peerName } : item)),
        );
      };

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          postSignal("ice", { candidate: event.candidate.toJSON() }, peerId).catch(() => {
            setError("Nao consegui enviar um pacote da conexao. Tente reconectar.");
          });
        }
      };

      peer.onconnectionstatechange = () => {
        if (["failed", "closed", "disconnected"].includes(peer.connectionState)) {
          peersRef.current.delete(peerId);
          setRemotePeers((items) => items.filter((item) => item.id !== peerId));
        }
      };

      return peer;
    },
    [postSignal],
  );

  const replaceVideoTrack = useCallback((track: MediaStreamTrack | null) => {
    peersRef.current.forEach((peer) => {
      const sender = peer.getSenders().find((item) => item.track?.kind === "video");
      if (sender) {
        sender.replaceTrack(track);
      } else if (track && localStreamRef.current) {
        peer.addTrack(track, localStreamRef.current);
      }
    });
  }, []);

  const ensureMedia = useCallback(async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setCameraOn(true);
      setMicOn(true);
      setStatus("Camera e microfone conectados.");
      await postSignal("join", { name: name || "Amigo" });
      return stream;
    } catch {
      setError("Permita camera e microfone no navegador para entrar na chamada.");
      throw new Error("media-denied");
    }
  }, [name, postSignal]);

  const joinCall = useCallback(async () => {
    const stream = localStreamRef.current ?? (await ensureMedia());
    peersRef.current.forEach((peer) => {
      stream.getTracks().forEach((track) => {
        if (!peer.getSenders().some((sender) => sender.track === track)) {
          peer.addTrack(track, stream);
        }
      });
    });
    await postSignal("join", { name: name || "Amigo" });
    setStatus("Na sala. Envie o link para seus amigos.");
  }, [ensureMedia, name, postSignal]);

  const handleSignal = useCallback(
    async (signal: SignalMessage) => {
      if (signal.senderId === clientId || knownSignalsRef.current.has(signal.id)) {
        return;
      }
      if (signal.recipientId && signal.recipientId !== clientId) {
        return;
      }

      knownSignalsRef.current.add(signal.id);
      const peerName = typeof signal.payload.name === "string" ? signal.payload.name : "Amigo";

      if (signal.kind === "leave") {
        peersRef.current.get(signal.senderId)?.close();
        peersRef.current.delete(signal.senderId);
        setRemotePeers((items) => items.filter((item) => item.id !== signal.senderId));
        return;
      }

      const peer = createPeer(signal.senderId, peerName);

      if (signal.kind === "join") {
        if (localStreamRef.current && clientId > signal.senderId) {
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          await postSignal("offer", { description: offer, name: name || "Amigo" }, signal.senderId);
        }
        return;
      }

      if (signal.kind === "offer") {
        await peer.setRemoteDescription(signal.payload.description as RTCSessionDescriptionInit);
        if (!localStreamRef.current) {
          setStatus("Um amigo entrou. Ative camera ou microfone para aparecer.");
        }
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await postSignal("answer", { description: answer, name: name || "Amigo" }, signal.senderId);
        return;
      }

      if (signal.kind === "answer") {
        await peer.setRemoteDescription(signal.payload.description as RTCSessionDescriptionInit);
        return;
      }

      if (signal.kind === "ice" && signal.payload.candidate) {
        await peer.addIceCandidate(signal.payload.candidate as RTCIceCandidateInit);
      }
    },
    [clientId, createPeer, name, postSignal],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadMessages() {
      try {
        const result = await api<{ messages: ChatMessage[] }>(`/api/messages?roomId=${encodeURIComponent(roomId)}`);
        if (!cancelled) {
          setMessages(result.messages);
        }
      } catch {
        if (!cancelled) {
          setError("Nao consegui carregar o chat salvo agora.");
        }
      }
    }

    loadMessages();
    const interval = window.setInterval(loadMessages, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [roomId]);

  useEffect(() => {
    let cancelled = false;

    async function pollSignals() {
      try {
        const result = await api<{ signals: SignalMessage[]; lastId: number }>(
          `/api/signals?roomId=${encodeURIComponent(roomId)}&after=${lastSignalId}`,
        );
        if (cancelled) {
          return;
        }
        for (const signal of result.signals) {
          await handleSignal(signal);
        }
        setLastSignalId(result.lastId);
      } catch {
        if (!cancelled) {
          setError("A sala perdeu a sincronizacao por um momento.");
        }
      }
    }

    pollSignals();
    const interval = window.setInterval(pollSignals, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [handleSignal, lastSignalId, roomId]);

  useEffect(() => {
    return () => {
      postSignal("leave", { name: name || "Amigo" }).catch(() => undefined);
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStream?.getTracks().forEach((track) => track.stop());
      peersRef.current.forEach((peer) => peer.close());
    };
  }, [name, postSignal, screenStream]);

  async function saveName(event: FormEvent) {
    event.preventDefault();
    const cleanName = draftName.trim() || "Amigo";
    window.localStorage.setItem("papo-nome", cleanName);
    setName(cleanName);
    await postSignal("join", { name: cleanName });
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const body = draftMessage.trim();
    if (!body) {
      return;
    }

    setDraftMessage("");
    const result = await api<{ message: ChatMessage }>("/api/messages", {
      method: "POST",
      body: JSON.stringify({
        roomId,
        authorId: clientId,
        authorName: name || "Amigo",
        body,
      }),
    });
    setMessages((items) => [...items, result.message]);
  }

  function toggleMic() {
    const audioTrack = localStream?.getAudioTracks()[0];
    if (!audioTrack) {
      return;
    }
    audioTrack.enabled = !audioTrack.enabled;
    setMicOn(audioTrack.enabled);
  }

  function toggleCamera() {
    const videoTrack = localStream?.getVideoTracks()[0];
    if (!videoTrack) {
      return;
    }
    videoTrack.enabled = !videoTrack.enabled;
    setCameraOn(videoTrack.enabled);
  }

  async function shareScreen() {
    setError("");
    if (screenStream) {
      const cameraTrack = localStream?.getVideoTracks()[0] ?? null;
      replaceVideoTrack(cameraTrack);
      screenStream.getTracks().forEach((track) => track.stop());
      setScreenStream(null);
      setStatus("Compartilhamento encerrado.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const [track] = stream.getVideoTracks();
      replaceVideoTrack(track);
      track.onended = () => {
        replaceVideoTrack(localStreamRef.current?.getVideoTracks()[0] ?? null);
        setScreenStream(null);
      };
      setScreenStream(stream);
      setStatus("Tela compartilhada.");
    } catch {
      setError("Nao consegui iniciar o compartilhamento de tela.");
    }
  }

  async function copyRoomLink() {
    await navigator.clipboard.writeText(roomLink);
    setStatus("Link copiado.");
  }

  function changeRoom(event: FormEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem("room") as HTMLInputElement;
    const cleanRoom = input.value.trim().replace(/[^a-zA-Z0-9_-]/g, "-") || "sala-amigos";
    const url = new URL(window.location.href);
    url.searchParams.set("room", cleanRoom);
    window.history.replaceState(null, "", url);
    peersRef.current.forEach((peer) => peer.close());
    peersRef.current.clear();
    setRemotePeers([]);
    setLastSignalId(0);
    knownSignalsRef.current.clear();
    setRoomId(cleanRoom);
    setStatus("Sala trocada.");
  }

  const visibleName = name || "Amigo";

  return (
    <main className="app-shell">
      <section className="call-area" aria-label="Chamada de video">
        <header className="topbar">
          <div>
            <p className="eyebrow">Papo ao vivo</p>
            <h1>Sala {roomId}</h1>
          </div>
          <div className="top-actions">
            <button type="button" className="ghost-button" onClick={copyRoomLink}>
              Copiar link
            </button>
            <button type="button" className="primary-button" onClick={joinCall}>
              Entrar
            </button>
          </div>
        </header>

        <div className="video-grid">
          <VideoTile stream={localStream} label={`${visibleName} (voce)`} muted active={Boolean(localStream)} />
          {remotePeers.map((peer) => (
            <VideoTile key={peer.id} stream={peer.stream} label={peer.name} active={Boolean(peer.stream)} />
          ))}
          {remotePeers.length === 0 ? (
            <div className="empty-tile">
              <span>Esperando amigos</span>
            </div>
          ) : null}
        </div>

        <div className="control-bar" aria-label="Controles da chamada">
          <button type="button" onClick={toggleMic} disabled={!localStream}>
            {micOn ? "Microfone ligado" : "Microfone mudo"}
          </button>
          <button type="button" onClick={toggleCamera} disabled={!localStream}>
            {cameraOn ? "Camera ligada" : "Camera pausada"}
          </button>
          <button type="button" onClick={shareScreen}>
            {screenStream ? "Parar tela" : "Compartilhar tela"}
          </button>
        </div>

        <div className="status-line" role={error ? "alert" : "status"}>
          {error || status}
        </div>
      </section>

      <aside className="side-panel" aria-label="Chat e sala">
        <form className="room-form" onSubmit={changeRoom}>
          <label htmlFor="room">Sala</label>
          <div className="inline-fields">
            <input id="room" name="room" defaultValue={roomId} aria-label="Nome da sala" />
            <button type="submit">Abrir</button>
          </div>
        </form>

        <form className="room-form" onSubmit={saveName}>
          <label htmlFor="name">Seu nome</label>
          <div className="inline-fields">
            <input
              id="name"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="Digite seu nome"
            />
            <button type="submit">Salvar</button>
          </div>
        </form>

        <section className="chat-panel" aria-label="Chat persistente">
          <div className="chat-head">
            <h2>Chat</h2>
            <span>{messages.length} mensagens</span>
          </div>
          <div className="messages">
            {messages.length === 0 ? (
              <p className="empty-chat">Nenhuma mensagem ainda.</p>
            ) : (
              messages.map((message) => (
                <article
                  className={`message ${message.authorId === clientId ? "mine" : ""}`}
                  key={message.id}
                >
                  <div>
                    <strong>{message.authorName}</strong>
                    <time dateTime={new Date(message.createdAt).toISOString()}>
                      {new Date(message.createdAt).toLocaleTimeString("pt-BR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                  <p>{message.body}</p>
                </article>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>
          <form className="composer" onSubmit={sendMessage}>
            <input
              value={draftMessage}
              onChange={(event) => setDraftMessage(event.target.value)}
              placeholder="Escreva uma mensagem"
              aria-label="Mensagem"
            />
            <button type="submit">Enviar</button>
          </form>
        </section>
      </aside>
    </main>
  );
}

function VideoTile({
  stream,
  label,
  muted = false,
  active,
}: {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  active: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className={`video-tile ${active ? "is-active" : ""}`}>
      <video ref={videoRef} autoPlay playsInline muted={muted} />
      <span>{label}</span>
    </div>
  );
}
