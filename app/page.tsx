"use client";

import { FormEvent, MouseEvent, useCallback, useEffect, useRef, useState } from "react";

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
  kind: "join" | "offer" | "answer" | "ice" | "leave" | "state";
  payload: Record<string, unknown>;
  createdAt: number;
};

type RemotePeer = {
  id: string;
  name: string;
  connectionId: string;
  stream: MediaStream | null;
  micOn: boolean;
  cameraOn: boolean;
  screenOn: boolean;
};

type PresenceParticipant = {
  roomId: string;
  clientId: string;
  name: string;
  micOn: boolean;
  cameraOn: boolean;
  screenOn: boolean;
  lastSeen: number;
};

type DeviceSelections = {
  audioInputId: string;
  videoInputId: string;
  audioOutputId: string;
};

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const DEFAULT_SERVER = "servidor-amigos";
const TEXT_CHANNELS = [
  { id: "geral", name: "geral" },
  { id: "avisos", name: "avisos" },
  { id: "memes", name: "memes" },
];
const VOICE_CHANNELS = [
  { id: "lounge", name: "Lounge" },
  { id: "jogos", name: "Jogos" },
  { id: "estudo", name: "Estudo" },
];
const CLIENT_STORAGE_KEY = "papo-client-id";
const ACTIVE_VOICE_STORAGE_KEY = "papo-voz-ativa";

function makeId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function asBoolean(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function readActiveVoice() {
  try {
    return JSON.parse(window.sessionStorage.getItem(ACTIVE_VOICE_STORAGE_KEY) ?? "null") as {
      serverId?: string;
      channelId?: string;
    } | null;
  } catch {
    window.sessionStorage.removeItem(ACTIVE_VOICE_STORAGE_KEY);
    return null;
  }
}

function serverPath(serverId: string) {
  return `/servers/${encodeURIComponent(serverId)}`;
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
  const [isReady, setIsReady] = useState(false);
  const serverId = DEFAULT_SERVER;
  const [selectedTextChannel, setSelectedTextChannel] = useState(TEXT_CHANNELS[0].id);
  const [selectedVoiceChannel, setSelectedVoiceChannel] = useState(VOICE_CHANNELS[0].id);
  const [clientId, setClientId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [name, setName] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftMessage, setDraftMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  const [presenceParticipants, setPresenceParticipants] = useState<PresenceParticipant[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [audioMuted, setAudioMuted] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [spotlightId, setSpotlightId] = useState("");
  const [mediaAccessStatus, setMediaAccessStatus] = useState<"unknown" | "granted" | "insecure" | "unsupported" | "denied">("unknown");
  const [mediaAccessMessage, setMediaAccessMessage] = useState("");
  const [mediaDevices, setMediaDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceSelections, setDeviceSelections] = useState<DeviceSelections>({
    audioInputId: "",
    videoInputId: "",
    audioOutputId: "",
  });
  const [status, setStatus] = useState("Entre com camera ou microfone para iniciar.");
  const [error, setError] = useState("");
  const [lastSignalId, setLastSignalId] = useState(0);

  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const peerConnectionIdsRef = useRef<Map<string, string>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const knownSignalsRef = useRef<Set<number>>(new Set());
  const autoJoinAttemptedRef = useRef(false);
  const lastSignalIdRef = useRef(0);

  useEffect(() => {
    const current = new URL(window.location.href);
    const targetPath = serverPath(DEFAULT_SERVER);

    if (current.pathname !== targetPath || current.searchParams.has("server") || current.searchParams.has("room")) {
      window.history.replaceState(null, "", targetPath);
    }

    const storedName = window.localStorage.getItem("papo-nome") ?? "";
    const storedClientId = window.sessionStorage.getItem(CLIENT_STORAGE_KEY) || makeId("pessoa");
    const storedVoice = readActiveVoice();
    window.sessionStorage.setItem(CLIENT_STORAGE_KEY, storedClientId);
    setClientId(storedClientId);
    setConnectionId(makeId("conexao"));
    if (storedVoice?.serverId === DEFAULT_SERVER && storedVoice.channelId && VOICE_CHANNELS.some((channel) => channel.id === storedVoice.channelId)) {
      setSelectedVoiceChannel(storedVoice.channelId);
    }
    setName(storedName);
    setDraftName(storedName);
    if (!window.isSecureContext) {
      setMediaAccessStatus("insecure");
      setMediaAccessMessage("Camera e microfone so funcionam em HTTPS ou localhost.");
    } else if (!navigator.mediaDevices?.getUserMedia) {
      setMediaAccessStatus("unsupported");
      setMediaAccessMessage("Este navegador nao disponibilizou camera e microfone para esta pagina.");
    }
    setIsReady(true);
  }, []);

  const textRoomKey = `${serverId}:texto:${selectedTextChannel}`;
  const voiceRoomKey = `${serverId}:voz:${selectedVoiceChannel}`;
  const currentTextChannel = TEXT_CHANNELS.find((channel) => channel.id === selectedTextChannel) ?? TEXT_CHANNELS[0];
  const currentVoiceChannel = VOICE_CHANNELS.find((channel) => channel.id === selectedVoiceChannel) ?? VOICE_CHANNELS[0];

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  useEffect(() => {
    screenStreamRef.current = screenStream;
  }, [screenStream]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    if (!localStream || !micOn) {
      setIsSpeaking(false);
      return undefined;
    }

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(localStream);
    const analyser = audioContext.createAnalyser();
    let animationFrame = 0;

    analyser.fftSize = 512;
    const data = new Uint8Array(analyser.fftSize);
    source.connect(analyser);

    const measure = () => {
      analyser.getByteTimeDomainData(data);
      let total = 0;
      for (const value of data) {
        const centered = value - 128;
        total += centered * centered;
      }
      const volume = Math.sqrt(total / data.length);
      setIsSpeaking(volume > 8);
      animationFrame = window.requestAnimationFrame(measure);
    };

    measure();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      source.disconnect();
      audioContext.close().catch(() => undefined);
      setIsSpeaking(false);
    };
  }, [localStream, micOn]);

  const postSignal = useCallback(
    async (kind: SignalMessage["kind"], payload: Record<string, unknown>, recipientId?: string) => {
      if (!clientId || !connectionId) {
        return;
      }

      await api<{ ok: boolean }>("/api/signals", {
        method: "POST",
        body: JSON.stringify({
          roomId: voiceRoomKey,
          senderId: clientId,
          recipientId: recipientId ?? null,
          kind,
          payload: { ...payload, connectionId },
        }),
      });
    },
    [clientId, connectionId, voiceRoomKey],
  );

  const postPresence = useCallback(async (overrideName?: string) => {
    if (!clientId || !localStreamRef.current) {
      return;
    }

    const stream = localStreamRef.current;
    await api<{ ok: boolean }>("/api/presence", {
      method: "POST",
      body: JSON.stringify({
        roomId: voiceRoomKey,
        clientId,
        name: overrideName || name || "Amigo",
        micOn: stream.getAudioTracks().some((track) => track.enabled),
        cameraOn: stream.getVideoTracks().some((track) => track.enabled),
        screenOn: Boolean(screenStreamRef.current),
      }),
    });
  }, [clientId, name, voiceRoomKey]);

  const leavePresence = useCallback(async () => {
    if (!clientId) {
      return;
    }

    await api<{ ok: boolean }>("/api/presence", {
      method: "DELETE",
      body: JSON.stringify({
        roomId: voiceRoomKey,
        clientId,
      }),
    });
  }, [clientId, voiceRoomKey]);

  const syncSignalCursor = useCallback(async () => {
    const result = await api<{ signals: SignalMessage[]; lastId: number }>(
      `/api/signals?roomId=${encodeURIComponent(voiceRoomKey)}&latest=1`,
    );
    lastSignalIdRef.current = result.lastId;
    setLastSignalId(result.lastId);
    knownSignalsRef.current.clear();
  }, [voiceRoomKey]);

  const renegotiatePeer = useCallback(
    async (peerId: string, peer: RTCPeerConnection) => {
      if (!localStreamRef.current || peer.signalingState !== "stable" || peer.connectionState === "closed") {
        return;
      }

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await postSignal("offer", {
        description: offer,
        name: name || "Amigo",
        micOn,
        cameraOn,
        screenOn: Boolean(screenStreamRef.current),
      }, peerId);
    },
    [cameraOn, micOn, name, postSignal],
  );

  const createPeer = useCallback(
    (peerId: string, peerName: string, peerConnectionId = "") => {
      const current = peersRef.current.get(peerId);
      if (current) {
        const existingConnectionId = peerConnectionIdsRef.current.get(peerId);
        if (!peerConnectionId || existingConnectionId === peerConnectionId) {
          return current;
        }

        current.close();
        peersRef.current.delete(peerId);
        peerConnectionIdsRef.current.delete(peerId);
        setRemotePeers((items) => items.filter((item) => item.id !== peerId));
      }

      const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peersRef.current.set(peerId, peer);
      peerConnectionIdsRef.current.set(peerId, peerConnectionId);
      setRemotePeers((items) => {
        if (items.some((item) => item.id === peerId)) {
          return items;
        }
        return [...items, { id: peerId, name: peerName, connectionId: peerConnectionId, stream: null, micOn: false, cameraOn: false, screenOn: false }];
      });

      localStreamRef.current?.getTracks().forEach((track) => {
        peer.addTrack(track, localStreamRef.current as MediaStream);
      });

      peer.ontrack = (event) => {
        setRemotePeers((items) =>
          items.map((item) => {
            if (item.id !== peerId) {
              return item;
            }

            const existingTracks = item.stream?.getTracks() ?? [];
            const streamTracks = event.streams[0]?.getTracks() ?? [event.track];
            const nextStream = new MediaStream(existingTracks);
            streamTracks.forEach((track) => {
              if (!nextStream.getTracks().some((currentTrack) => currentTrack.id === track.id)) {
                nextStream.addTrack(track);
              }
            });

            return { ...item, stream: nextStream, name: peerName, connectionId: peerConnectionId || item.connectionId };
          }),
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
          peerConnectionIdsRef.current.delete(peerId);
          setRemotePeers((items) => items.filter((item) => item.id !== peerId));
        }
      };

      return peer;
    },
    [postSignal],
  );

  const replaceVideoTrack = useCallback((track: MediaStreamTrack | null) => {
    peersRef.current.forEach((peer) => {
      if (peer.connectionState === "closed" || peer.signalingState === "closed") {
        peersRef.current.forEach((candidate, id) => {
          if (candidate === peer) {
            peersRef.current.delete(id);
            peerConnectionIdsRef.current.delete(id);
          }
        });
        return;
      }

      const sender = peer.getSenders().find((item) => item.track?.kind === "video");
      if (sender) {
        sender.replaceTrack(track).catch(() => {
          if (peer.connectionState === "closed" || peer.signalingState === "closed") {
            peersRef.current.forEach((candidate, id) => {
              if (candidate === peer) {
                peersRef.current.delete(id);
                peerConnectionIdsRef.current.delete(id);
              }
            });
          }
        });
      } else if (track && localStreamRef.current) {
        try {
          peer.addTrack(track, localStreamRef.current);
          peersRef.current.forEach((candidate, id) => {
            if (candidate === peer) {
              renegotiatePeer(id, peer).catch(() => undefined);
            }
          });
        } catch {
          peersRef.current.forEach((candidate, id) => {
            if (candidate === peer) {
              peersRef.current.delete(id);
              peerConnectionIdsRef.current.delete(id);
            }
          });
        }
      }
    });
  }, [renegotiatePeer]);

  const replaceAudioTrack = useCallback((track: MediaStreamTrack | null) => {
    peersRef.current.forEach((peer) => {
      if (peer.connectionState === "closed" || peer.signalingState === "closed") {
        return;
      }

      const sender = peer.getSenders().find((item) => item.track?.kind === "audio");
      if (sender) {
        sender.replaceTrack(track).catch(() => undefined);
      } else if (track && localStreamRef.current) {
        try {
          peer.addTrack(track, localStreamRef.current);
          peersRef.current.forEach((candidate, id) => {
            if (candidate === peer) {
              renegotiatePeer(id, peer).catch(() => undefined);
            }
          });
        } catch {
          // Closed peer; it will be removed by the connection state handler.
        }
      }
    });
  }, [renegotiatePeer]);

  const refreshDevices = useCallback(async () => {
    if (!window.isSecureContext) {
      setMediaAccessStatus("insecure");
      setMediaAccessMessage("Use HTTPS para listar e permitir camera/microfone.");
      return;
    }

    if (!navigator.mediaDevices?.enumerateDevices) {
      setMediaAccessStatus("unsupported");
      setMediaAccessMessage("Este navegador nao permite listar dispositivos nesta pagina.");
      return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    setMediaDevices(devices);
  }, []);

  const getMediaConstraints = useCallback((): MediaStreamConstraints => {
    return {
      audio: deviceSelections.audioInputId
        ? { deviceId: { exact: deviceSelections.audioInputId } }
        : true,
      video: deviceSelections.videoInputId
        ? { deviceId: { exact: deviceSelections.videoInputId } }
        : true,
    };
  }, [deviceSelections.audioInputId, deviceSelections.videoInputId]);

  const applySelectedDevices = useCallback(async () => {
    setError("");
    if (!localStreamRef.current) {
      await refreshDevices();
      setStatus("Dispositivos selecionados para a proxima entrada no canal.");
      return null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints());
      const previousStream = localStreamRef.current;
      previousStream?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = stream;
      setLocalStream(stream);
      setCameraOn(Boolean(stream.getVideoTracks()[0]?.enabled));
      setMicOn(Boolean(stream.getAudioTracks()[0]?.enabled));
      replaceAudioTrack(stream.getAudioTracks()[0] ?? null);
      replaceVideoTrack(screenStreamRef.current?.getVideoTracks()[0] ?? stream.getVideoTracks()[0] ?? null);
      await refreshDevices();
      setStatus("Dispositivos atualizados.");
      return stream;
    } catch {
      setError("Nao consegui usar os dispositivos selecionados.");
      return null;
    }
  }, [getMediaConstraints, refreshDevices, replaceAudioTrack, replaceVideoTrack]);

  const requestDeviceAccess = useCallback(async () => {
    setError("");

    if (!window.isSecureContext) {
      setMediaAccessStatus("insecure");
      setMediaAccessMessage("Acesse por HTTPS para o navegador liberar camera e microfone.");
      setError("Camera e microfone exigem HTTPS. Use seu dominio com Certbot, nao o IP em HTTP.");
      return null;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setMediaAccessStatus("unsupported");
      setMediaAccessMessage("Este navegador nao disponibilizou permissoes de midia.");
      return null;
    }

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints());
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }

      setMediaAccessStatus("granted");
      setMediaAccessMessage("Permissao concedida. Dispositivos carregados.");
      await refreshDevices();

      if (!localStreamRef.current) {
        stream.getTracks().forEach((track) => track.stop());
      }

      return stream;
    } catch {
      setMediaAccessStatus("denied");
      setMediaAccessMessage("Permissao negada ou nenhum dispositivo disponivel.");
      setError("O navegador bloqueou camera/microfone. Libere a permissao no cadeado da barra de endereco.");
      return null;
    }
  }, [getMediaConstraints, refreshDevices]);

  const ensureMedia = useCallback(async () => {
    setError("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      await requestDeviceAccess();
      return null;
    }

    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints());
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: deviceSelections.audioInputId
            ? { deviceId: { exact: deviceSelections.audioInputId } }
            : true,
          video: false,
        });
        setStatus("Conectado apenas com microfone.");
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      setCameraOn(Boolean(stream.getVideoTracks()[0]?.enabled));
      setMicOn(Boolean(stream.getAudioTracks()[0]?.enabled));
      if (stream.getVideoTracks().length > 0) {
        setStatus("Camera e microfone conectados.");
      }
      await refreshDevices();
      setMediaAccessStatus("granted");
      setMediaAccessMessage("Permissao concedida. Dispositivos carregados.");
      return stream;
    } catch {
      setError("Permita camera ou microfone no navegador para entrar na chamada.");
      return null;
    }
  }, [deviceSelections.audioInputId, getMediaConstraints, refreshDevices, requestDeviceAccess]);

  const joinCall = useCallback(async () => {
    const stream = localStreamRef.current ?? (await ensureMedia());
    if (!stream) {
      return;
    }

    await syncSignalCursor();
    peersRef.current.forEach((peer, peerId) => {
      let addedTrack = false;
      stream.getTracks().forEach((track) => {
        if (!peer.getSenders().some((sender) => sender.track === track)) {
          peer.addTrack(track, stream);
          addedTrack = true;
        }
      });
      if (addedTrack) {
        renegotiatePeer(peerId, peer).catch(() => undefined);
      }
    });
    await postSignal("join", {
      name: name || "Amigo",
      micOn: stream.getAudioTracks().some((track) => track.enabled),
      cameraOn: stream.getVideoTracks().some((track) => track.enabled),
      screenOn: Boolean(screenStreamRef.current),
    });
    window.sessionStorage.setItem(ACTIVE_VOICE_STORAGE_KEY, JSON.stringify({ serverId, channelId: selectedVoiceChannel }));
    await postPresence();
    setStatus(`Conectado ao canal de voz ${currentVoiceChannel.name}.`);
  }, [currentVoiceChannel.name, ensureMedia, name, postPresence, postSignal, renegotiatePeer, selectedVoiceChannel, serverId, syncSignalCursor]);

  useEffect(() => {
    if (!isReady || !clientId || localStream || autoJoinAttemptedRef.current) {
      return;
    }

    const storedVoice = readActiveVoice();

    if (storedVoice?.serverId !== serverId || storedVoice.channelId !== selectedVoiceChannel) {
      return;
    }

    autoJoinAttemptedRef.current = true;
    joinCall().catch(() => undefined);
  }, [clientId, isReady, joinCall, localStream, selectedVoiceChannel, serverId]);

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
      const signalConnectionId = typeof signal.payload.connectionId === "string" ? signal.payload.connectionId : "";
      const mediaState = {
        name: peerName,
        micOn: asBoolean(signal.payload.micOn, true),
        cameraOn: asBoolean(signal.payload.cameraOn),
        screenOn: asBoolean(signal.payload.screenOn),
      };

      if (signal.kind === "leave") {
        const existingConnectionId = peerConnectionIdsRef.current.get(signal.senderId);
        if (!signalConnectionId || !existingConnectionId || existingConnectionId === signalConnectionId) {
          peersRef.current.get(signal.senderId)?.close();
          peersRef.current.delete(signal.senderId);
          peerConnectionIdsRef.current.delete(signal.senderId);
          setRemotePeers((items) => items.filter((item) => item.id !== signal.senderId));
        }
        return;
      }

      if (signal.kind === "state") {
        setRemotePeers((items) =>
          items.map((item) =>
            item.id === signal.senderId
              ? { ...item, ...mediaState, connectionId: signalConnectionId || item.connectionId }
              : item,
          ),
        );
        return;
      }

      const peer = createPeer(signal.senderId, peerName, signalConnectionId);
      setRemotePeers((items) =>
        items.map((item) =>
          item.id === signal.senderId
            ? { ...item, ...mediaState, connectionId: signalConnectionId || item.connectionId }
            : item,
        ),
      );

      if (signal.kind === "join") {
        if (localStreamRef.current && clientId > signal.senderId) {
          if (peer.signalingState !== "stable") {
            return;
          }
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
          await postSignal(
            "offer",
            {
              description: offer,
              name: name || "Amigo",
              micOn,
              cameraOn,
              screenOn: Boolean(screenStreamRef.current),
            },
            signal.senderId,
          );
        }
        return;
      }

      if (signal.kind === "offer") {
        if (peer.signalingState === "closed") {
          return;
        }
        await peer.setRemoteDescription(signal.payload.description as RTCSessionDescriptionInit);
        if (!localStreamRef.current) {
          setStatus("Um amigo entrou. Ative camera ou microfone para aparecer.");
        }
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        await postSignal(
          "answer",
          {
            description: answer,
            name: name || "Amigo",
            micOn,
            cameraOn,
            screenOn: Boolean(screenStreamRef.current),
          },
          signal.senderId,
        );
        return;
      }

      if (signal.kind === "answer") {
        if (peer.signalingState !== "have-local-offer") {
          return;
        }
        await peer.setRemoteDescription(signal.payload.description as RTCSessionDescriptionInit);
        return;
      }

      if (signal.kind === "ice" && signal.payload.candidate) {
        try {
          await peer.addIceCandidate(signal.payload.candidate as RTCIceCandidateInit);
        } catch {
          // The candidate can arrive after a refresh replaced the peer.
        }
      }
    },
    [cameraOn, clientId, createPeer, micOn, name, postSignal],
  );

  useEffect(() => {
    if (!isReady) {
      return undefined;
    }

    let cancelled = false;

    async function loadMessages() {
      try {
        const result = await api<{ messages: ChatMessage[] }>(`/api/messages?roomId=${encodeURIComponent(textRoomKey)}`);
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
  }, [isReady, textRoomKey]);

  useEffect(() => {
    if (!isReady || !clientId || !localStream) {
      return undefined;
    }

    let cancelled = false;

    async function pollSignals() {
      try {
        const result = await api<{ signals: SignalMessage[]; lastId: number }>(
          `/api/signals?roomId=${encodeURIComponent(voiceRoomKey)}&after=${lastSignalIdRef.current}`,
        );
        if (cancelled) {
          return;
        }
        for (const signal of result.signals) {
          try {
            await handleSignal(signal);
          } catch {
            // Ignore stale negotiation messages so fresh signals can keep flowing.
          }
        }
        lastSignalIdRef.current = result.lastId;
        setLastSignalId(result.lastId);
      } catch {
        if (!cancelled) {
          setError("O canal de voz perdeu a sincronizacao por um momento.");
        }
      }
    }

    pollSignals();
    const interval = window.setInterval(pollSignals, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [clientId, handleSignal, isReady, localStream, voiceRoomKey]);

  useEffect(() => {
    if (!isReady || !clientId) {
      return undefined;
    }

    let cancelled = false;

    async function loadPresence() {
      try {
        const result = await api<{ participants: PresenceParticipant[] }>(
          `/api/presence?roomId=${encodeURIComponent(voiceRoomKey)}`,
        );
        if (cancelled) {
          return;
        }

        setPresenceParticipants(result.participants);
        const onlineIds = new Set(result.participants.map((participant) => participant.clientId));
        setRemotePeers((items) =>
          items
            .filter((peer) => onlineIds.has(peer.id))
            .map((peer) => {
              const presence = result.participants.find((participant) => participant.clientId === peer.id);
              return presence
                ? {
                    ...peer,
                    name: presence.name,
                    micOn: presence.micOn,
                    cameraOn: presence.cameraOn,
                    screenOn: presence.screenOn,
                  }
                : peer;
            }),
        );
      } catch {
        if (!cancelled) {
          setError("Nao consegui atualizar a lista do canal agora.");
        }
      }
    }

    loadPresence();
    const interval = window.setInterval(loadPresence, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [clientId, isReady, voiceRoomKey]);

  useEffect(() => {
    if (!localStream || !clientId) {
      return undefined;
    }

    postPresence().catch(() => undefined);
    const interval = window.setInterval(() => {
      postPresence().catch(() => undefined);
    }, 3000);

    return () => {
      window.clearInterval(interval);
    };
  }, [clientId, localStream, micOn, cameraOn, screenStream, postPresence]);

  useEffect(() => {
    return () => {
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      peersRef.current.forEach((peer) => peer.close());
      peerConnectionIdsRef.current.clear();
    };
  }, []);

  async function saveName(event: FormEvent) {
    event.preventDefault();
    const cleanName = draftName.trim() || "Amigo";
    window.localStorage.setItem("papo-nome", cleanName);
    setName(cleanName);
    await postSignal("state", {
      name: cleanName,
      micOn,
      cameraOn,
      screenOn: Boolean(screenStreamRef.current),
    });
    await postPresence(cleanName);
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
        roomId: textRoomKey,
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
    postSignal("state", {
      name: name || "Amigo",
      micOn: audioTrack.enabled,
      cameraOn,
      screenOn: Boolean(screenStreamRef.current),
    }).catch(() => undefined);
    postPresence().catch(() => undefined);
  }

  function toggleCamera() {
    const videoTrack = localStream?.getVideoTracks()[0];
    if (!videoTrack) {
      return;
    }
    videoTrack.enabled = !videoTrack.enabled;
    setCameraOn(videoTrack.enabled);
    postSignal("state", {
      name: name || "Amigo",
      micOn,
      cameraOn: videoTrack.enabled,
      screenOn: Boolean(screenStreamRef.current),
    }).catch(() => undefined);
    postPresence().catch(() => undefined);
  }

  function disconnectCall() {
    postSignal("leave", { name: name || "Amigo" }).catch(() => undefined);
    leavePresence().catch(() => undefined);
    window.sessionStorage.removeItem(ACTIVE_VOICE_STORAGE_KEY);
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStream?.getTracks().forEach((track) => track.stop());
    peersRef.current.forEach((peer) => peer.close());
    peersRef.current.clear();
    peerConnectionIdsRef.current.clear();
    setLocalStream(null);
    setScreenStream(null);
    setRemotePeers([]);
    setSpotlightId("");
    setCameraOn(false);
    setMicOn(false);
    setStatus("Desconectado da chamada.");
  }

  async function shareScreen() {
    setError("");
    if (screenStream) {
      const cameraTrack = localStream?.getVideoTracks()[0] ?? null;
      replaceVideoTrack(cameraTrack);
      screenStream.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
      setScreenStream(null);
      postSignal("state", {
        name: name || "Amigo",
        micOn,
        cameraOn: Boolean(cameraTrack && cameraTrack.enabled),
        screenOn: false,
      }).catch(() => undefined);
      postPresence().catch(() => undefined);
      setStatus("Compartilhamento encerrado.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const [track] = stream.getVideoTracks();
      replaceVideoTrack(track);
      track.onended = () => {
        try {
          replaceVideoTrack(localStreamRef.current?.getVideoTracks()[0] ?? null);
        } catch {
          setError("A conexao de video ja tinha sido encerrada.");
        }
        screenStreamRef.current = null;
        setScreenStream(null);
        postSignal("state", {
          name: name || "Amigo",
          micOn,
          cameraOn: Boolean(localStreamRef.current?.getVideoTracks()[0]?.enabled),
          screenOn: false,
        }).catch(() => undefined);
        postPresence().catch(() => undefined);
      };
      screenStreamRef.current = stream;
      setScreenStream(stream);
      postSignal("state", {
        name: name || "Amigo",
        micOn,
        cameraOn: true,
        screenOn: true,
      }).catch(() => undefined);
      postPresence().catch(() => undefined);
      setStatus("Tela compartilhada.");
    } catch {
      setError("Nao consegui iniciar o compartilhamento de tela.");
    }
  }

  function switchTextChannel(channelId: string) {
    setSelectedTextChannel(channelId);
    setMessages([]);
    setStatus(`Canal #${channelId} aberto.`);
  }

  function switchVoiceChannel(channelId: string) {
    if (channelId === selectedVoiceChannel) {
      return;
    }

    postSignal("leave", { name: name || "Amigo" }).catch(() => undefined);
    leavePresence().catch(() => undefined);
    peersRef.current.forEach((peer) => peer.close());
    peersRef.current.clear();
    peerConnectionIdsRef.current.clear();
    setRemotePeers([]);
    setPresenceParticipants([]);
    lastSignalIdRef.current = 0;
    setLastSignalId(0);
    knownSignalsRef.current.clear();
    setSpotlightId("");
    setSelectedVoiceChannel(channelId);
    if (localStreamRef.current) {
      window.sessionStorage.setItem(ACTIVE_VOICE_STORAGE_KEY, JSON.stringify({ serverId, channelId }));
    }
    setStatus(`Canal de voz ${VOICE_CHANNELS.find((channel) => channel.id === channelId)?.name ?? channelId} selecionado.`);
  }

  const visibleName = name || "Amigo";
  const localPreviewStream = screenStream ?? localStream;
  const localPreviewLabel = screenStream ? `${visibleName} (sua tela)` : `${visibleName} (voce)`;
  const localVideoVisible = Boolean(screenStream || (localStream && cameraOn));
  const isConnected = Boolean(localStream);
  const connectionLabel = isConnected ? "Conectado" : "Desconectado";
  const activeParticipants = remotePeers.length + (isConnected ? 1 : 0);
  const audioInputDevices = mediaDevices.filter((device) => device.kind === "audioinput");
  const videoInputDevices = mediaDevices.filter((device) => device.kind === "videoinput");
  const audioOutputDevices = mediaDevices.filter((device) => device.kind === "audiooutput");
  const localTileId = "local";
  const videoTiles = [
    {
      id: localTileId,
      stream: localPreviewStream,
      label: localPreviewLabel,
      muted: true,
      active: localVideoVisible,
      micOn: micOn && isConnected,
      cameraOn: localVideoVisible,
      connectionLabel,
      isSpeaking: isSpeaking && micOn && isConnected,
      audioOutputId: "",
    },
    ...remotePeers.map((peer) => ({
      id: peer.id,
      stream: peer.stream,
      label: peer.name,
      muted: audioMuted,
      active: Boolean(peer.stream && (peer.cameraOn || peer.screenOn) && peer.stream.getVideoTracks().some((track) => track.readyState === "live")),
      micOn: peer.micOn,
      cameraOn: peer.cameraOn || peer.screenOn,
      connectionLabel: peer.stream ? "Conectado" : "Conectando",
      isSpeaking: false,
      audioOutputId: deviceSelections.audioOutputId,
    })),
  ];
  const spotlightTile = videoTiles.find((tile) => tile.id === spotlightId && tile.active) ?? null;
  const voiceParticipants = presenceParticipants.length > 0
    ? presenceParticipants.map((participant) => ({
        id: participant.clientId,
        name: participant.clientId === clientId ? visibleName : participant.name,
        isLocal: participant.clientId === clientId,
      }))
    : [
        ...(isConnected ? [{ id: clientId || "local", name: visibleName, isLocal: true }] : []),
        ...remotePeers.map((peer) => ({ id: peer.id, name: peer.name, isLocal: false })),
      ];

  return (
    <main className="app-shell">
      <nav className="server-rail" aria-label="Servidor fixo">
        <div className="server-mark" title="Papo Vivo">PV</div>
      </nav>

      <aside className="channel-sidebar" aria-label="Canais do servidor">
        <div className="server-header">
          <span>Servidor</span>
          <strong>{serverId}</strong>
        </div>

        <section className="channel-section" aria-label="Canais de texto">
          <div className="channel-heading">Texto</div>
          {TEXT_CHANNELS.map((channel) => (
            <button
              type="button"
              key={channel.id}
              className={`channel-button ${selectedTextChannel === channel.id ? "is-selected" : ""}`}
              onClick={() => switchTextChannel(channel.id)}
            >
              <span>#</span>
              {channel.name}
            </button>
          ))}
        </section>

        <section className="channel-section" aria-label="Canais de voz">
          <div className="channel-heading">Voz</div>
          {VOICE_CHANNELS.map((channel) => (
            <div className="voice-channel-group" key={channel.id}>
              <button
                type="button"
                className={`channel-button voice-channel ${selectedVoiceChannel === channel.id ? "is-selected" : ""}`}
                onClick={() => switchVoiceChannel(channel.id)}
              >
                <span>◉</span>
                {channel.name}
              </button>
              {selectedVoiceChannel === channel.id && voiceParticipants.length > 0 ? (
                <div className="voice-participants">
                  {voiceParticipants.map((participant) => (
                    <div className="voice-participant" key={participant.id}>
                      <span>{participant.name.slice(0, 1).toUpperCase()}</span>
                      <p>{participant.name}{participant.isLocal ? " (voce)" : ""}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </section>
      </aside>

      <section className="call-area" aria-label="Chamada de video">
        <header className="topbar">
          <div>
            <p className="eyebrow">Papo ao vivo</p>
            <h1>{serverId}</h1>
            <div className="status-pills" aria-label="Status da chamada">
              <span className={`status-pill ${isConnected ? "is-online" : "is-offline"}`}>
                {connectionLabel}
              </span>
              <span className={`status-pill ${micOn && isConnected ? "is-online" : "is-muted"}`}>
                Mic {micOn && isConnected ? "ligado" : "mudo"}
              </span>
              <span className={`status-pill ${cameraOn && isConnected ? "is-online" : "is-muted"}`}>
                Cam {cameraOn && isConnected ? "ligada" : "pausada"}
              </span>
            </div>
          </div>
          <div className="top-actions">
            {!isConnected ? (
              <button type="button" className="primary-button" onClick={joinCall} disabled={!isReady}>
                Entrar no canal
              </button>
            ) : null}
          </div>
        </header>

        <div className="stage-area">
          {spotlightTile ? (
            <VideoTile
              key={`spotlight-${spotlightTile.id}`}
              stream={spotlightTile.stream}
              label={spotlightTile.label}
              muted={spotlightTile.muted}
              active={spotlightTile.active}
              micOn={spotlightTile.micOn}
              cameraOn={spotlightTile.cameraOn}
              connectionLabel={spotlightTile.connectionLabel}
              isSpeaking={spotlightTile.isSpeaking}
              audioOutputId={spotlightTile.audioOutputId}
              isSpotlight
              isSelected
            />
          ) : null}

          <div className={`video-grid ${spotlightTile ? "has-spotlight" : ""}`}>
            {videoTiles.map((tile) => (
              <VideoTile
                key={`${tile.id}-${tile.id === localTileId && screenStream ? "screen" : "camera"}`}
                stream={tile.stream}
                label={tile.label}
                muted={tile.muted}
                active={tile.active}
                micOn={tile.micOn}
                cameraOn={tile.cameraOn}
                connectionLabel={tile.connectionLabel}
                isSpeaking={tile.isSpeaking}
                audioOutputId={tile.audioOutputId}
                isSelected={spotlightId === tile.id && tile.active}
                onSelect={tile.active ? () => setSpotlightId((current) => (current === tile.id ? "" : tile.id)) : undefined}
              />
            ))}
            {remotePeers.length === 0 ? (
            <div className="empty-tile">
              <div>
                <strong>{isConnected ? `Canal ${currentVoiceChannel.name}` : "Voce esta desconectado"}</strong>
                <p>{isConnected ? "Convide amigos para o servidor." : "Entre em um canal de voz para falar."}</p>
              </div>
            </div>
            ) : null}
          </div>
        </div>

        {isConnected ? (
          <div className="control-bar" aria-label="Controles da chamada">
            <button type="button" className={`icon-button ${micOn ? "control-on" : "control-off"}`} onClick={toggleMic} aria-label={micOn ? "Mutar microfone" : "Ativar microfone"} title={micOn ? "Mutar microfone" : "Ativar microfone"}>
              <span className="icon icon-mic" />
            </button>
            <button type="button" className={`icon-button ${cameraOn ? "control-on" : "control-off"}`} onClick={toggleCamera} aria-label={cameraOn ? "Pausar camera" : "Ativar camera"} title={cameraOn ? "Pausar camera" : "Ativar camera"}>
              <span className="icon icon-camera" />
            </button>
            <button type="button" className={`icon-button ${screenStream ? "control-on" : ""}`} onClick={shareScreen} aria-label={screenStream ? "Parar compartilhamento" : "Compartilhar tela"} title={screenStream ? "Parar compartilhamento" : "Compartilhar tela"}>
              <span className="icon icon-screen" />
            </button>
            <button type="button" className={`icon-button ${audioMuted ? "control-off" : ""}`} onClick={() => setAudioMuted((value) => !value)} aria-label={audioMuted ? "Ouvir amigos" : "Mutar audio dos amigos"} title={audioMuted ? "Ouvir amigos" : "Mutar audio dos amigos"}>
              <span className="icon icon-audio" />
            </button>
            <button type="button" className="icon-button danger-button" onClick={disconnectCall} aria-label="Sair do canal" title="Sair do canal">
              <span className="icon icon-phone" />
            </button>
          </div>
        ) : null}

        <div className="status-line" role={error ? "alert" : "status"}>
          {error || status}
        </div>
      </section>

      <aside className="side-panel" aria-label="Chat e servidor">
        <section className="voice-card" aria-label="Resumo do canal de voz">
          <div className="voice-card-main">
            <div>
              <span className={`presence-dot ${isConnected ? "is-online" : "is-offline"}`} />
              <strong>{currentVoiceChannel.name}</strong>
            </div>
            <p>{connectionLabel} · {activeParticipants} na voz</p>
          </div>
          <button
            type="button"
            className="icon-button compact"
            aria-label="Selecionar dispositivos"
            title="Selecionar dispositivos"
            onClick={() => {
              setDevicesOpen((value) => !value);
              refreshDevices().catch(() => undefined);
            }}
          >
            <span className="icon icon-settings" />
          </button>
        </section>

        {devicesOpen ? (
          <section className="device-panel" aria-label="Dispositivos de audio e video">
            <div className="device-head">
              <h2>Dispositivos</h2>
              <button type="button" className="icon-button compact" onClick={() => setDevicesOpen(false)} aria-label="Fechar dispositivos" title="Fechar">
                <span className="icon icon-close" />
              </button>
            </div>
            {mediaAccessStatus !== "granted" ? (
              <div className={`device-notice ${mediaAccessStatus}`}>
                <p>{mediaAccessMessage || "Permita acesso para carregar nomes de microfone, camera e saida de audio."}</p>
                <button type="button" onClick={() => requestDeviceAccess().catch(() => undefined)}>
                  Permitir acesso
                </button>
              </div>
            ) : (
              <p className="device-ok">{mediaAccessMessage || "Dispositivos liberados."}</p>
            )}
            <label htmlFor="audio-input">Microfone</label>
            <select
              id="audio-input"
              value={deviceSelections.audioInputId}
              onChange={(event) => setDeviceSelections((value) => ({ ...value, audioInputId: event.target.value }))}
              disabled={mediaAccessStatus === "insecure" || mediaAccessStatus === "unsupported"}
            >
              <option value="">Padrao do navegador</option>
              {audioInputDevices.map((device, index) => (
                <option value={device.deviceId} key={device.deviceId}>
                  {device.label || `Microfone ${index + 1}`}
                </option>
              ))}
            </select>

            <label htmlFor="video-input">Camera</label>
            <select
              id="video-input"
              value={deviceSelections.videoInputId}
              onChange={(event) => setDeviceSelections((value) => ({ ...value, videoInputId: event.target.value }))}
              disabled={mediaAccessStatus === "insecure" || mediaAccessStatus === "unsupported"}
            >
              <option value="">Padrao do navegador</option>
              {videoInputDevices.map((device, index) => (
                <option value={device.deviceId} key={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
            </select>

            <label htmlFor="audio-output">Saida de audio</label>
            <select
              id="audio-output"
              value={deviceSelections.audioOutputId}
              onChange={(event) => setDeviceSelections((value) => ({ ...value, audioOutputId: event.target.value }))}
              disabled={mediaAccessStatus === "insecure" || mediaAccessStatus === "unsupported"}
            >
              <option value="">Padrao do navegador</option>
              {audioOutputDevices.map((device, index) => (
                <option value={device.deviceId} key={device.deviceId}>
                  {device.label || `Saida ${index + 1}`}
                </option>
              ))}
            </select>

            <button type="button" onClick={() => applySelectedDevices().catch(() => undefined)} disabled={mediaAccessStatus === "insecure" || mediaAccessStatus === "unsupported"}>
              Aplicar dispositivos
            </button>
          </section>
        ) : null}

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
            <h2>#{currentTextChannel.name}</h2>
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
  micOn,
  cameraOn,
  connectionLabel,
  isSpeaking = false,
  audioOutputId = "",
  isSpotlight = false,
  isSelected = false,
  onSelect,
}: {
  stream: MediaStream | null;
  label: string;
  muted?: boolean;
  active: boolean;
  micOn: boolean;
  cameraOn: boolean;
  connectionLabel: string;
  isSpeaking?: boolean;
  audioOutputId?: string;
  isSpotlight?: boolean;
  isSelected?: boolean;
  onSelect?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tileRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(() => undefined);
    }
    if (audioRef.current) {
      audioRef.current.srcObject = stream;
      audioRef.current.play().catch(() => undefined);
    }
  }, [stream]);

  useEffect(() => {
    const audio = audioRef.current as (HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    }) | null;

    if (audio?.setSinkId) {
      audio.setSinkId(audioOutputId).catch(() => undefined);
    }
  }, [audioOutputId]);

  function openFullscreen(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    tileRef.current?.requestFullscreen?.().catch(() => undefined);
  }

  return (
    <div
      ref={tileRef}
      className={`video-tile ${active ? "is-active" : ""} ${isSpeaking ? "is-speaking" : ""} ${isSpotlight ? "is-spotlight" : ""} ${isSelected ? "is-selected" : ""} ${onSelect ? "is-selectable" : ""}`}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (onSelect && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect();
        }
      }}
      aria-label={onSelect ? `Destacar ${label}` : undefined}
      title={onSelect ? `Destacar ${label}` : undefined}
    >
      <video ref={videoRef} autoPlay playsInline muted />
      <audio ref={audioRef} autoPlay muted={muted} />
      {!active ? <div className="avatar-fallback">{label.slice(0, 1).toUpperCase()}</div> : null}
      <div className="tile-badges">
        <span className={connectionLabel === "Conectado" ? "badge-online" : "badge-offline"}>{connectionLabel}</span>
        <span className={micOn ? "badge-online" : "badge-muted"}>{micOn ? "Mic" : "Mudo"}</span>
        <span className={cameraOn ? "badge-online" : "badge-muted"}>{cameraOn ? "Cam" : "Sem cam"}</span>
      </div>
      <span className="tile-name">{label}</span>
      {active ? (
        <button
          type="button"
          className="fullscreen-button"
          onClick={openFullscreen}
          aria-label={`Abrir ${label} em tela cheia`}
          title="Tela cheia"
        >
          <span className="icon icon-fullscreen" />
        </button>
      ) : null}
    </div>
  );
}

