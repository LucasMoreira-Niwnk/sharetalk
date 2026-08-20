"use client";

import { ChangeEvent, FormEvent, MouseEvent, useCallback, useEffect, useRef, useState } from "react";

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
  avatarUrl: string;
  connectionId: string;
  connectionState: RTCPeerConnectionState;
  stream: MediaStream | null;
  voiceStream: MediaStream | null;
  screenAudioStream: MediaStream | null;
  micOn: boolean;
  cameraOn: boolean;
  screenOn: boolean;
};

type PresenceParticipant = {
  roomId: string;
  clientId: string;
  name: string;
  avatarUrl: string;
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

type ChannelKind = "text" | "voice";

type ServerChannel = {
  id: string;
  name: string;
  type: ChannelKind;
  createdAt: number;
  updatedAt: number;
};

type UserProfile = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
};

type StoredSession = {
  userId: string;
  token: string;
};

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const APP_NAME = "Sharetalk";
const DEFAULT_SERVER = "infernus";
const SERVER_DISPLAY_NAME = "Infernus";
const DEFAULT_TEXT_CHANNELS: ServerChannel[] = [
  { id: "geral", name: "geral", type: "text", createdAt: 0, updatedAt: 0 },
  { id: "avisos", name: "avisos", type: "text", createdAt: 0, updatedAt: 0 },
  { id: "memes", name: "memes", type: "text", createdAt: 0, updatedAt: 0 },
];
const DEFAULT_VOICE_CHANNELS: ServerChannel[] = [
  { id: "lounge", name: "Lounge", type: "voice", createdAt: 0, updatedAt: 0 },
  { id: "jogos", name: "Jogos", type: "voice", createdAt: 0, updatedAt: 0 },
  { id: "estudo", name: "Estudo", type: "voice", createdAt: 0, updatedAt: 0 },
];
const CLIENT_STORAGE_KEY = "papo-client-id";
const ACTIVE_VOICE_STORAGE_KEY = "papo-voz-ativa";
const AUTH_STORAGE_KEY = "sharetalk-session";

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

function readStoredSession() {
  try {
    return JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) ?? "null") as StoredSession | null;
  } catch {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    return null;
  }
}

function avatarInitial(name: string) {
  return (name.trim()[0] || "A").toUpperCase();
}

function readImageFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function playTone(frequency: number, duration = 0.16, gainValue = 0.055) {
  try {
    const AudioContextClass = window.AudioContext || (window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;

    if (!AudioContextClass) {
      return;
    }

    const audioContext = new AudioContextClass();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const now = audioContext.currentTime;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(gainValue, now + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.03);
    window.setTimeout(() => audioContext.close().catch(() => undefined), Math.ceil((duration + 0.12) * 1000));
  } catch {
    // Notification sounds are optional and must never interrupt the call.
  }
}

function serverPath(serverId: string) {
  return `/servers/${encodeURIComponent(serverId)}`;
}

function getVideoSender(peer: RTCPeerConnection) {
  const transceiver = peer.getTransceivers().find((item) =>
    item.sender.track?.kind === "video" || item.receiver.track.kind === "video",
  );

  return transceiver?.sender ?? peer.getSenders().find((item) => item.track?.kind === "video") ?? null;
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
  const [textChannels, setTextChannels] = useState<ServerChannel[]>(DEFAULT_TEXT_CHANNELS);
  const [voiceChannels, setVoiceChannels] = useState<ServerChannel[]>(DEFAULT_VOICE_CHANNELS);
  const [selectedTextChannel, setSelectedTextChannel] = useState(DEFAULT_TEXT_CHANNELS[0].id);
  const [selectedVoiceChannel, setSelectedVoiceChannel] = useState(DEFAULT_VOICE_CHANNELS[0].id);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [authToken, setAuthToken] = useState("");
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [authUsername, setAuthUsername] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [authAvatarUrl, setAuthAvatarUrl] = useState("");
  const [authError, setAuthError] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileAvatarUrl, setProfileAvatarUrl] = useState("");
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
  const [peerVoiceVolumes, setPeerVoiceVolumes] = useState<Record<string, number>>({});
  const [peerLiveVolumes, setPeerLiveVolumes] = useState<Record<string, number>>({});
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
  const screenAudioTrackRef = useRef<MediaStreamTrack | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const knownSignalsRef = useRef<Set<number>>(new Set());
  const knownMessageIdsRef = useRef<Set<number>>(new Set());
  const initialMessagesLoadedRef = useRef(false);
  const previousScreenSharingIdsRef = useRef<Set<string>>(new Set());
  const autoJoinAttemptedRef = useRef(false);
  const lastSignalIdRef = useRef(0);
  const connectionRequestsRef = useRef<Map<string, number>>(new Map());

  const loadChannels = useCallback(async () => {
    const result = await api<{ channels: ServerChannel[] }>(`/api/channels?serverId=${encodeURIComponent(serverId)}`);
    const nextTextChannels = result.channels.filter((channel) => channel.type === "text");
    const nextVoiceChannels = result.channels.filter((channel) => channel.type === "voice");

    setTextChannels(nextTextChannels.length > 0 ? nextTextChannels : DEFAULT_TEXT_CHANNELS);
    setVoiceChannels(nextVoiceChannels.length > 0 ? nextVoiceChannels : DEFAULT_VOICE_CHANNELS);
    setSelectedTextChannel((current) => nextTextChannels.some((channel) => channel.id === current) ? current : (nextTextChannels[0]?.id ?? DEFAULT_TEXT_CHANNELS[0].id));
    setSelectedVoiceChannel((current) => nextVoiceChannels.some((channel) => channel.id === current) ? current : (nextVoiceChannels[0]?.id ?? DEFAULT_VOICE_CHANNELS[0].id));
  }, [serverId]);

  useEffect(() => {
    let cancelled = false;
    const current = new URL(window.location.href);
    const targetPath = serverPath(DEFAULT_SERVER);

    if (current.pathname !== targetPath || current.searchParams.has("server") || current.searchParams.has("room")) {
      window.history.replaceState(null, "", targetPath);
    }

    const storedVoice = readActiveVoice();
    setConnectionId(makeId("conexao"));
    if (storedVoice?.serverId === DEFAULT_SERVER && storedVoice.channelId) {
      setSelectedVoiceChannel(storedVoice.channelId);
    }
    if (!window.isSecureContext) {
      setMediaAccessStatus("insecure");
      setMediaAccessMessage("Camera e microfone so funcionam em HTTPS ou localhost.");
    } else if (!navigator.mediaDevices?.getUserMedia) {
      setMediaAccessStatus("unsupported");
      setMediaAccessMessage("Este navegador nao disponibilizou camera e microfone para esta pagina.");
    }

    async function restoreSession() {
      const storedSession = readStoredSession();

      if (!storedSession?.userId || !storedSession.token) {
        return;
      }

      try {
        const result = await api<{ user: UserProfile }>(
          `/api/auth/me?userId=${encodeURIComponent(storedSession.userId)}&token=${encodeURIComponent(storedSession.token)}`,
        );
        if (cancelled) {
          return;
        }
        setCurrentUser(result.user);
        setAuthToken(storedSession.token);
        setClientId(result.user.id);
        window.sessionStorage.setItem(CLIENT_STORAGE_KEY, result.user.id);
        setName(result.user.displayName);
        setDraftName(result.user.displayName);
        setProfileName(result.user.displayName);
        setProfileAvatarUrl(result.user.avatarUrl);
      } catch {
        window.localStorage.removeItem(AUTH_STORAGE_KEY);
      }
    }

    restoreSession().finally(() => {
      if (!cancelled) {
        setIsReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isReady || !currentUser || !clientId) {
      return undefined;
    }

    loadChannels().catch(() => setError("Nao consegui atualizar a lista de canais agora."));
    const interval = window.setInterval(() => {
      loadChannels().catch(() => undefined);
    }, 5000);

    return () => window.clearInterval(interval);
  }, [clientId, currentUser, isReady, loadChannels]);

  const textRoomKey = `${serverId}:texto:${selectedTextChannel}`;
  const voiceRoomKey = `${serverId}:voz:${selectedVoiceChannel}`;
  const currentTextChannel = textChannels.find((channel) => channel.id === selectedTextChannel) ?? textChannels[0] ?? DEFAULT_TEXT_CHANNELS[0];
  const currentVoiceChannel = voiceChannels.find((channel) => channel.id === selectedVoiceChannel) ?? voiceChannels[0] ?? DEFAULT_VOICE_CHANNELS[0];

  useEffect(() => {
    localStreamRef.current = localStream;
  }, [localStream]);

  useEffect(() => {
    screenStreamRef.current = screenStream;
  }, [screenStream]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
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
        avatarUrl: currentUser?.avatarUrl ?? "",
        micOn: stream.getAudioTracks().some((track) => track.enabled),
        cameraOn: stream.getVideoTracks().some((track) => track.enabled),
        screenOn: Boolean(screenStreamRef.current),
      }),
    });
  }, [clientId, currentUser?.avatarUrl, name, voiceRoomKey]);

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
        avatarUrl: currentUser?.avatarUrl ?? "",
        micOn,
        cameraOn,
        screenOn: Boolean(screenStreamRef.current),
      }, peerId);
    },
    [cameraOn, currentUser?.avatarUrl, micOn, name, postSignal],
  );

  const addLocalTracksToPeer = useCallback((peer: RTCPeerConnection) => {
    const localStream = localStreamRef.current;
    if (!localStream) {
      return;
    }

    const microphoneTrack = localStream.getAudioTracks()[0] ?? null;
    const cameraTrack = localStream.getVideoTracks()[0] ?? null;
    const screenTrack = screenStreamRef.current?.getVideoTracks()[0] ?? null;
    const screenAudioTrack = screenAudioTrackRef.current;

    if (microphoneTrack) {
      peer.addTrack(microphoneTrack, new MediaStream([microphoneTrack]));
    }
    if (screenTrack) {
      peer.addTrack(screenTrack, screenStreamRef.current as MediaStream);
    } else if (cameraTrack) {
      peer.addTrack(cameraTrack, new MediaStream([cameraTrack]));
    } else if (!getVideoSender(peer)) {
      peer.addTransceiver("video", { direction: "sendonly" });
    }
    if (screenAudioTrack && screenStreamRef.current) {
      peer.addTrack(screenAudioTrack, screenStreamRef.current);
    }
  }, []);

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
        return [
          ...items,
          {
            id: peerId,
            name: peerName,
            avatarUrl: "",
            connectionId: peerConnectionId,
            connectionState: peer.connectionState,
            stream: null,
            voiceStream: null,
            screenAudioStream: null,
            micOn: false,
            cameraOn: false,
            screenOn: false,
          },
        ];
      });

      addLocalTracksToPeer(peer);

      peer.ontrack = (event) => {
        setRemotePeers((items) =>
          items.map((item) => {
            if (item.id !== peerId) {
              return item;
            }

            const sourceStream = event.streams[0] ?? null;
            const streamTracks = sourceStream?.getTracks() ?? [event.track];
            const sourceHasVideo = Boolean(sourceStream?.getVideoTracks().length);
            const videoTracks = streamTracks.filter((track) => track.kind === "video");
            const audioTracks = streamTracks.filter((track) => track.kind === "audio");
            const nextVideoStream = item.stream ? new MediaStream(item.stream.getVideoTracks()) : new MediaStream();
            let nextVoiceStream = item.voiceStream;
            let nextScreenAudioStream = item.screenAudioStream;

            videoTracks.forEach((track) => {
              if (!nextVideoStream.getVideoTracks().some((currentTrack) => currentTrack.id === track.id)) {
                nextVideoStream.addTrack(track);
              }
            });

            audioTracks.forEach((track) => {
              const isVoiceTrack = nextVoiceStream?.getAudioTracks().some((currentTrack) => currentTrack.id === track.id);
              const isScreenAudioTrack = nextScreenAudioStream?.getAudioTracks().some((currentTrack) => currentTrack.id === track.id);

              if (isVoiceTrack || isScreenAudioTrack) {
                return;
              }

              if (sourceHasVideo) {
                nextScreenAudioStream = new MediaStream([track]);
              } else if (!nextVoiceStream) {
                nextVoiceStream = new MediaStream([track]);
              } else {
                nextScreenAudioStream = new MediaStream([track]);
              }
            });

            return {
              ...item,
              stream: nextVideoStream.getVideoTracks().length > 0 ? nextVideoStream : item.stream,
              voiceStream: nextVoiceStream,
              screenAudioStream: nextScreenAudioStream,
              name: peerName,
              avatarUrl: item.avatarUrl,
              connectionId: peerConnectionId || item.connectionId,
            };
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
        const nextState = peer.connectionState;

        setRemotePeers((items) =>
          items.map((item) => (item.id === peerId ? { ...item, connectionState: nextState } : item)),
        );

        if (["failed", "closed"].includes(nextState)) {
          peersRef.current.delete(peerId);
          peerConnectionIdsRef.current.delete(peerId);
          connectionRequestsRef.current.delete(peerId);
          setRemotePeers((items) => items.filter((item) => item.id !== peerId));
        }
      };

      return peer;
    },
    [addLocalTracksToPeer, postSignal],
  );

  const replaceVideoTrack = useCallback((track: MediaStreamTrack | null) => {
    peersRef.current.forEach((peer) => {
      if (peer.connectionState === "closed" || peer.signalingState === "closed") {
        peersRef.current.forEach((candidate, id) => {
          if (candidate === peer) {
            peersRef.current.delete(id);
            peerConnectionIdsRef.current.delete(id);
            connectionRequestsRef.current.delete(id);
          }
        });
        return;
      }

      const sender = getVideoSender(peer);
      if (sender) {
        sender.replaceTrack(track).catch(() => {
          if (peer.connectionState === "closed" || peer.signalingState === "closed") {
            peersRef.current.forEach((candidate, id) => {
              if (candidate === peer) {
                peersRef.current.delete(id);
                peerConnectionIdsRef.current.delete(id);
                connectionRequestsRef.current.delete(id);
              }
            });
          }
        });
      } else if (track && localStreamRef.current) {
        try {
          const transceiver = peer.addTransceiver("video", {
            direction: "sendonly",
            streams: [new MediaStream([track])],
          } as RTCRtpTransceiverInit);
          transceiver.sender.replaceTrack(track).catch(() => undefined);
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
              connectionRequestsRef.current.delete(id);
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

      const sender = peer.getSenders().find((item) => item.track?.kind === "audio" && item.track !== screenAudioTrackRef.current);
      if (sender) {
        sender.replaceTrack(track).catch(() => undefined);
      } else if (track && localStreamRef.current) {
        try {
          peer.addTrack(track, new MediaStream([track]));
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

  const stopScreenAudioShare = useCallback(() => {
    const screenAudioTrack = screenAudioTrackRef.current;
    if (!screenAudioTrack) {
      return;
    }

    peersRef.current.forEach((peer, peerId) => {
      const sender = peer.getSenders().find((item) => item.track === screenAudioTrack);
      if (!sender) {
        return;
      }

      try {
        peer.removeTrack(sender);
        renegotiatePeer(peerId, peer).catch(() => undefined);
      } catch {
        sender.replaceTrack(null).catch(() => undefined);
      }
    });

    screenAudioTrackRef.current = null;
  }, [renegotiatePeer]);

  const startScreenAudioShare = useCallback((displayStream: MediaStream) => {
    stopScreenAudioShare();
    const displayAudioTrack = displayStream.getAudioTracks()[0];

    if (!displayAudioTrack) {
      return false;
    }

    screenAudioTrackRef.current = displayAudioTrack;
    peersRef.current.forEach((peer, peerId) => {
      if (peer.connectionState === "closed" || peer.signalingState === "closed") {
        return;
      }

      try {
        peer.addTrack(displayAudioTrack, displayStream);
        renegotiatePeer(peerId, peer).catch(() => undefined);
      } catch {
        // Existing peer can be closing while screen share starts.
      }
    });

    displayAudioTrack.onended = () => {
      stopScreenAudioShare();
    };

    return true;
  }, [renegotiatePeer, stopScreenAudioShare]);

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

  const getMediaConstraints = useCallback((includeVideo = true): MediaStreamConstraints => {
    return {
      audio: deviceSelections.audioInputId
        ? { deviceId: { exact: deviceSelections.audioInputId } }
        : true,
      video: includeVideo
        ? deviceSelections.videoInputId
          ? { deviceId: { exact: deviceSelections.videoInputId } }
          : true
        : false,
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
      const stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints(cameraOn));
      const previousStream = localStreamRef.current;
      previousStream?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = stream;
      setLocalStream(stream);
      setCameraOn(Boolean(stream.getVideoTracks()[0]?.enabled));
      setMicOn(Boolean(stream.getAudioTracks()[0]?.enabled));
      replaceVideoTrack(screenStreamRef.current?.getVideoTracks()[0] ?? stream.getVideoTracks()[0] ?? null);
      if (screenStreamRef.current) {
        startScreenAudioShare(screenStreamRef.current);
      } else {
        replaceAudioTrack(stream.getAudioTracks()[0] ?? null);
      }
      await refreshDevices();
      setStatus("Dispositivos atualizados.");
      return stream;
    } catch {
      setError("Nao consegui usar os dispositivos selecionados.");
      return null;
    }
  }, [cameraOn, getMediaConstraints, refreshDevices, replaceAudioTrack, replaceVideoTrack, startScreenAudioShare]);

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
        stream = await navigator.mediaDevices.getUserMedia(getMediaConstraints(false));
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
      setCameraOn(false);
      setMicOn(Boolean(stream.getAudioTracks()[0]?.enabled));
      setStatus("Microfone conectado. Camera entra desligada.");
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
      avatarUrl: currentUser?.avatarUrl ?? "",
      micOn: stream.getAudioTracks().some((track) => track.enabled),
      cameraOn: stream.getVideoTracks().some((track) => track.enabled),
      screenOn: Boolean(screenStreamRef.current),
    });
    window.sessionStorage.setItem(ACTIVE_VOICE_STORAGE_KEY, JSON.stringify({ serverId, channelId: selectedVoiceChannel }));
    await postPresence();
    try {
      const result = await api<{ participants: PresenceParticipant[] }>(
        `/api/presence?roomId=${encodeURIComponent(voiceRoomKey)}`,
      );
      await Promise.all(result.participants
        .filter((participant) => participant.clientId !== clientId)
        .map((participant) => {
          connectionRequestsRef.current.set(participant.clientId, Date.now());
          return postSignal("join", {
            name: name || "Amigo",
            avatarUrl: currentUser?.avatarUrl ?? "",
            micOn: stream.getAudioTracks().some((track) => track.enabled),
            cameraOn: stream.getVideoTracks().some((track) => track.enabled),
            screenOn: Boolean(screenStreamRef.current),
          }, participant.clientId).catch(() => undefined);
        }));
    } catch {
      // The broadcast join above is enough; direct joins only make connection faster.
    }
    setStatus(`Conectado ao canal de voz ${currentVoiceChannel.name}.`);
  }, [clientId, currentUser?.avatarUrl, currentVoiceChannel.name, ensureMedia, name, postPresence, postSignal, renegotiatePeer, selectedVoiceChannel, serverId, syncSignalCursor, voiceRoomKey]);

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
      const peerAvatarUrl = typeof signal.payload.avatarUrl === "string" ? signal.payload.avatarUrl : "";
      const signalConnectionId = typeof signal.payload.connectionId === "string" ? signal.payload.connectionId : "";
      const mediaState = {
        name: peerName,
        avatarUrl: peerAvatarUrl,
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
          connectionRequestsRef.current.delete(signal.senderId);
          previousScreenSharingIdsRef.current.delete(signal.senderId);
          setRemotePeers((items) => items.filter((item) => item.id !== signal.senderId));
        }
        return;
      }

      if (signal.kind === "state") {
        const wasSharing = previousScreenSharingIdsRef.current.has(signal.senderId);
        setRemotePeers((items) =>
          items.map((item) =>
            item.id === signal.senderId
              ? { ...item, ...mediaState, connectionId: signalConnectionId || item.connectionId }
              : item,
          ),
        );
        if (!wasSharing && mediaState.screenOn) {
          playTone(520, 0.18, 0.05);
        }
        if (mediaState.screenOn) {
          previousScreenSharingIdsRef.current.add(signal.senderId);
        } else {
          previousScreenSharingIdsRef.current.delete(signal.senderId);
        }
        return;
      }

      const wasSharing = previousScreenSharingIdsRef.current.has(signal.senderId);
      const peer = createPeer(signal.senderId, peerName, signalConnectionId);
      setRemotePeers((items) =>
        items.map((item) =>
          item.id === signal.senderId
            ? { ...item, ...mediaState, connectionId: signalConnectionId || item.connectionId }
            : item,
        ),
      );
      if (!wasSharing && mediaState.screenOn) {
        playTone(520, 0.18, 0.05);
      }
      if (mediaState.screenOn) {
        previousScreenSharingIdsRef.current.add(signal.senderId);
      } else {
        previousScreenSharingIdsRef.current.delete(signal.senderId);
      }

      if (signal.kind === "join") {
        if (localStreamRef.current) {
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
              avatarUrl: currentUser?.avatarUrl ?? "",
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
            avatarUrl: currentUser?.avatarUrl ?? "",
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
    [cameraOn, clientId, createPeer, currentUser?.avatarUrl, micOn, name, postSignal],
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
          const freshMessages = result.messages.filter((message) => !knownMessageIdsRef.current.has(message.id));
          const shouldNotify = initialMessagesLoadedRef.current && freshMessages.some((message) => message.authorId !== clientId);
          result.messages.forEach((message) => knownMessageIdsRef.current.add(message.id));
          initialMessagesLoadedRef.current = true;
          setMessages(result.messages);
          if (shouldNotify) {
            playTone(720, 0.13, 0.045);
          }
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
  }, [clientId, currentUser, isReady, textRoomKey]);

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
    const interval = window.setInterval(pollSignals, 800);
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
        for (const peerId of connectionRequestsRef.current.keys()) {
          if (!onlineIds.has(peerId)) {
            connectionRequestsRef.current.delete(peerId);
          }
        }
        setRemotePeers((items) =>
          items
            .filter((peer) => onlineIds.has(peer.id))
            .map((peer) => {
              const presence = result.participants.find((participant) => participant.clientId === peer.id);
              return presence
                ? {
                  ...peer,
                  name: presence.name,
                  avatarUrl: presence.avatarUrl,
                  micOn: presence.micOn,
                  cameraOn: presence.cameraOn,
                  screenOn: presence.screenOn,
                }
                : peer;
            }),
        );

        if (localStreamRef.current) {
          const now = Date.now();
          for (const participant of result.participants) {
            if (participant.clientId === clientId) {
              continue;
            }

            const peer = peersRef.current.get(participant.clientId);
            const needsConnection =
              !peer ||
              peer.connectionState === "closed" ||
              peer.connectionState === "failed" ||
              peer.connectionState === "disconnected";
            const lastRequest = connectionRequestsRef.current.get(participant.clientId) ?? 0;

            if (needsConnection && now - lastRequest > 1000) {
              connectionRequestsRef.current.set(participant.clientId, now);
              postSignal(
                "join",
                {
                  name: name || "Amigo",
                  avatarUrl: currentUser?.avatarUrl ?? "",
                  micOn,
                  cameraOn,
                  screenOn: Boolean(screenStreamRef.current),
                },
                participant.clientId,
              ).catch(() => undefined);
            }
          }
        }
      } catch {
        if (!cancelled) {
          setError("Nao consegui atualizar a lista do canal agora.");
        }
      }
    }

    loadPresence();
    const interval = window.setInterval(loadPresence, 900);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [cameraOn, clientId, currentUser?.avatarUrl, isReady, micOn, name, postSignal, voiceRoomKey]);

  useEffect(() => {
    if (!localStream || !clientId) {
      return undefined;
    }

    postPresence().catch(() => undefined);
    const interval = window.setInterval(() => {
      postPresence().catch(() => undefined);
    }, 1500);

    return () => {
      window.clearInterval(interval);
    };
  }, [clientId, localStream, micOn, cameraOn, screenStream, postPresence]);

  useEffect(() => {
    return () => {
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenAudioTrackRef.current?.stop();
      peersRef.current.forEach((peer) => peer.close());
      peerConnectionIdsRef.current.clear();
    };
  }, []);

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    if (!currentUser || !authToken) {
      return;
    }

    const cleanName = profileName.trim() || currentUser.displayName || "Amigo";
    const result = await api<{ user: UserProfile }>("/api/auth/profile", {
      method: "PATCH",
      body: JSON.stringify({
        userId: currentUser.id,
        token: authToken,
        displayName: cleanName,
        avatarUrl: profileAvatarUrl,
      }),
    });
    setCurrentUser(result.user);
    setName(result.user.displayName);
    setDraftName(result.user.displayName);
    setProfileName(result.user.displayName);
    setProfileAvatarUrl(result.user.avatarUrl);
    setProfileOpen(false);
    await postSignal("state", {
      name: result.user.displayName,
      avatarUrl: result.user.avatarUrl,
      micOn,
      cameraOn,
      screenOn: Boolean(screenStreamRef.current),
    });
    await postPresence(result.user.displayName);
    setStatus("Perfil atualizado.");
  }

  async function handleProfileAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setError("Escolha uma imagem para a foto de perfil.");
      return;
    }

    const dataUrl = await readImageFile(file);
    setProfileAvatarUrl(dataUrl);
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
      avatarUrl: currentUser?.avatarUrl ?? "",
      micOn: audioTrack.enabled,
      cameraOn,
      screenOn: Boolean(screenStreamRef.current),
    }).catch(() => undefined);
    postPresence().catch(() => undefined);
  }

  async function toggleCamera() {
    const videoTrack = localStream?.getVideoTracks()[0];
    if (!localStream) {
      return;
    }

    if (!videoTrack) {
      try {
        const cameraStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: deviceSelections.videoInputId
            ? { deviceId: { exact: deviceSelections.videoInputId } }
            : true,
        });
        const [newVideoTrack] = cameraStream.getVideoTracks();
        if (!newVideoTrack) {
          setError("Nao encontrei camera para ativar.");
          return;
        }
        localStream.addTrack(newVideoTrack);
        localStreamRef.current = localStream;
        setLocalStream(new MediaStream(localStream.getTracks()));
        if (!screenStreamRef.current) {
          replaceVideoTrack(newVideoTrack);
        }
        setCameraOn(true);
        await refreshDevices();
        postSignal("state", {
          name: name || "Amigo",
          avatarUrl: currentUser?.avatarUrl ?? "",
          micOn,
          cameraOn: true,
          screenOn: Boolean(screenStreamRef.current),
        }).catch(() => undefined);
        postPresence().catch(() => undefined);
      } catch {
        setError("Nao consegui ativar a camera. Confira a permissao do navegador.");
      }
      return;
    }

    videoTrack.enabled = !videoTrack.enabled;
    replaceVideoTrack(screenStreamRef.current?.getVideoTracks()[0] ?? (videoTrack.enabled ? videoTrack : null));
    setCameraOn(videoTrack.enabled);
    postSignal("state", {
      name: name || "Amigo",
      avatarUrl: currentUser?.avatarUrl ?? "",
      micOn,
      cameraOn: videoTrack.enabled,
      screenOn: Boolean(screenStreamRef.current),
    }).catch(() => undefined);
    postPresence().catch(() => undefined);
  }

  function disconnectCall() {
    postSignal("leave", { name: name || "Amigo", avatarUrl: currentUser?.avatarUrl ?? "" }).catch(() => undefined);
    leavePresence().catch(() => undefined);
    window.sessionStorage.removeItem(ACTIVE_VOICE_STORAGE_KEY);
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    stopScreenAudioShare();
    screenStream?.getTracks().forEach((track) => track.stop());
    peersRef.current.forEach((peer) => peer.close());
    peersRef.current.clear();
    peerConnectionIdsRef.current.clear();
    connectionRequestsRef.current.clear();
    setLocalStream(null);
    setScreenStream(null);
    setRemotePeers([]);
    previousScreenSharingIdsRef.current.clear();
    setSpotlightId("");
    setCameraOn(false);
    setMicOn(false);
    setStatus("Desconectado da chamada.");
  }

  function getDisplayMediaOptions(): DisplayMediaStreamOptions {
    return {
      video: {
        displaySurface: "window",
      },
      audio: {
        suppressLocalAudioPlayback: false,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
      },
      preferCurrentTab: false,
      systemAudio: "include",
      windowAudio: "system",
      monitorTypeSurfaces: "include",
      selfBrowserSurface: "include",
      surfaceSwitching: "include",
    } as DisplayMediaStreamOptions;
  }

  async function shareScreen() {
    setError("");
    if (screenStream) {
      const cameraTrack = localStream?.getVideoTracks()[0] ?? null;
      replaceVideoTrack(cameraTrack);
      stopScreenAudioShare();
      screenStream.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
      setScreenStream(null);
      postSignal("state", {
        name: name || "Amigo",
        avatarUrl: currentUser?.avatarUrl ?? "",
        micOn,
        cameraOn: Boolean(cameraTrack && cameraTrack.enabled),
        screenOn: false,
      }).catch(() => undefined);
      postPresence().catch(() => undefined);
      setStatus("Compartilhamento encerrado.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(getDisplayMediaOptions());
      const [track] = stream.getVideoTracks();
      const sharingAudio = startScreenAudioShare(stream);
      const displaySurface = track.getSettings().displaySurface;
      replaceVideoTrack(track);
      track.onended = () => {
        try {
          replaceVideoTrack(localStreamRef.current?.getVideoTracks()[0] ?? null);
          stopScreenAudioShare();
        } catch {
          setError("A conexao de video ja tinha sido encerrada.");
        }
        screenStreamRef.current = null;
        setScreenStream(null);
        postSignal("state", {
          name: name || "Amigo",
          avatarUrl: currentUser?.avatarUrl ?? "",
          micOn,
          cameraOn: Boolean(localStreamRef.current?.getVideoTracks()[0]?.enabled),
          screenOn: false,
        }).catch(() => undefined);
        postPresence().catch(() => undefined);
      };
      screenStreamRef.current = stream;
      setScreenStream(stream);
      playTone(520, 0.18, 0.05);
      postSignal("state", {
        name: name || "Amigo",
        avatarUrl: currentUser?.avatarUrl ?? "",
        micOn,
        cameraOn: true,
        screenOn: true,
      }).catch(() => undefined);
      postPresence().catch(() => undefined);
      if (sharingAudio) {
        setStatus(displaySurface === "window"
          ? "Janela compartilhada com audio do sistema."
          : "Tela compartilhada com audio.");
      } else {
        setStatus("Tela compartilhada sem audio. No Windows, marque Compartilhar audio no seletor do Chrome/Edge; se a janela nao oferecer audio, compartilhe a tela inteira ou uma aba.");
      }
    } catch {
      setError("Nao consegui iniciar o compartilhamento de tela.");
    }
  }

  function switchTextChannel(channelId: string) {
    setSelectedTextChannel(channelId);
    setMessages([]);
    knownMessageIdsRef.current.clear();
    initialMessagesLoadedRef.current = false;
    setStatus(`Canal #${channelId} aberto.`);
  }

  function switchVoiceChannel(channelId: string) {
    if (channelId === selectedVoiceChannel) {
      return;
    }

    postSignal("leave", { name: name || "Amigo", avatarUrl: currentUser?.avatarUrl ?? "" }).catch(() => undefined);
    leavePresence().catch(() => undefined);
    peersRef.current.forEach((peer) => peer.close());
    peersRef.current.clear();
    peerConnectionIdsRef.current.clear();
    connectionRequestsRef.current.clear();
    setRemotePeers([]);
    setPresenceParticipants([]);
    previousScreenSharingIdsRef.current.clear();
    lastSignalIdRef.current = 0;
    setLastSignalId(0);
    knownSignalsRef.current.clear();
    setSpotlightId("");
    setSelectedVoiceChannel(channelId);
    if (localStreamRef.current) {
      window.sessionStorage.setItem(ACTIVE_VOICE_STORAGE_KEY, JSON.stringify({ serverId, channelId }));
    }
    setStatus(`Canal de voz ${voiceChannels.find((channel) => channel.id === channelId)?.name ?? channelId} selecionado.`);
  }

  async function createChannel(type: ChannelKind) {
    const label = type === "text" ? "texto" : "voz";
    const nameValue = window.prompt(`Nome do novo canal de ${label}:`)?.trim();
    if (!nameValue) {
      return;
    }

    try {
      const result = await api<{ channel: ServerChannel }>("/api/channels", {
        method: "POST",
        body: JSON.stringify({ serverId, type, name: nameValue }),
      });
      await loadChannels();
      if (type === "text") {
        switchTextChannel(result.channel.id);
      } else {
        switchVoiceChannel(result.channel.id);
      }
      setStatus(`Canal ${nameValue} criado.`);
    } catch {
      setError("Nao consegui criar o canal agora.");
    }
  }

  async function renameChannel(channel: ServerChannel) {
    const nameValue = window.prompt("Novo nome do canal:", channel.name)?.trim();
    if (!nameValue || nameValue === channel.name) {
      return;
    }

    try {
      await api<{ channel: ServerChannel }>("/api/channels", {
        method: "PATCH",
        body: JSON.stringify({ serverId, id: channel.id, name: nameValue }),
      });
      await loadChannels();
      setStatus(`Canal renomeado para ${nameValue}.`);
    } catch {
      setError("Nao consegui renomear o canal agora.");
    }
  }

  async function removeChannel(channel: ServerChannel) {
    const channels = channel.type === "text" ? textChannels : voiceChannels;
    if (channels.length <= 1) {
      setError("Mantenha pelo menos um canal de cada tipo.");
      return;
    }

    if (!window.confirm(`Remover o canal ${channel.type === "text" ? "#" : ""}${channel.name}?`)) {
      return;
    }

    try {
      await api<{ ok: boolean }>("/api/channels", {
        method: "DELETE",
        body: JSON.stringify({ serverId, id: channel.id }),
      });
      if (channel.type === "text" && selectedTextChannel === channel.id) {
        setSelectedTextChannel(channels.find((item) => item.id !== channel.id)?.id ?? DEFAULT_TEXT_CHANNELS[0].id);
        setMessages([]);
        knownMessageIdsRef.current.clear();
        initialMessagesLoadedRef.current = false;
      }
      if (channel.type === "voice" && selectedVoiceChannel === channel.id) {
        if (localStreamRef.current) {
          disconnectCall();
        }
        setSelectedVoiceChannel(channels.find((item) => item.id !== channel.id)?.id ?? DEFAULT_VOICE_CHANNELS[0].id);
      }
      await loadChannels();
      setStatus(`Canal ${channel.name} removido.`);
    } catch {
      setError("Nao consegui remover o canal agora.");
    }
  }

  async function handleAuthSubmit(event: FormEvent) {
    event.preventDefault();
    setAuthError("");

    try {
      const path = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
      const result = await api<{ user: UserProfile; token: string }>(path, {
        method: "POST",
        body: JSON.stringify({
          username: authUsername,
          password: authPassword,
          displayName: authDisplayName || authUsername,
          avatarUrl: authAvatarUrl,
        }),
      });

      window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ userId: result.user.id, token: result.token }));
      window.sessionStorage.setItem(CLIENT_STORAGE_KEY, result.user.id);
      setCurrentUser(result.user);
      setAuthToken(result.token);
      setClientId(result.user.id);
      setName(result.user.displayName);
      setDraftName(result.user.displayName);
      setProfileName(result.user.displayName);
      setProfileAvatarUrl(result.user.avatarUrl);
      setAuthPassword("");
      setStatus(`Bem-vindo ao ${SERVER_DISPLAY_NAME}.`);
    } catch {
      setAuthError(authMode === "register" ? "Nao consegui criar essa conta." : "Usuario ou senha invalidos.");
    }
  }

  async function handleAuthAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setAuthError("Escolha uma imagem para a foto de perfil.");
      return;
    }

    setAuthAvatarUrl(await readImageFile(file));
  }

  function logout() {
    disconnectCall();
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    window.sessionStorage.removeItem(CLIENT_STORAGE_KEY);
    setCurrentUser(null);
    setAuthToken("");
    setClientId("");
    setName("");
    setDraftName("");
    setProfileOpen(false);
    setAuthPassword("");
    knownMessageIdsRef.current.clear();
    initialMessagesLoadedRef.current = false;
    previousScreenSharingIdsRef.current.clear();
    setStatus("Entre na sua conta para acessar o servidor.");
  }

  const visibleName = name || "Amigo";
  const localPreviewStream = screenStream ?? localStream;
  const localPreviewLabel = screenStream ? `${visibleName} (sua tela)` : `${visibleName} (voce)`;
  const localVideoVisible = Boolean(screenStream || (localStream && cameraOn));
  const isConnected = Boolean(localStream);
  const connectionLabel = isConnected ? "Conectado" : "Desconectado";
  const connectedRemotePeers = remotePeers.filter((peer) => peer.connectionState === "connected");
  const activeParticipants = connectedRemotePeers.length + (isConnected ? 1 : 0);
  const audioInputDevices = mediaDevices.filter((device) => device.kind === "audioinput");
  const videoInputDevices = mediaDevices.filter((device) => device.kind === "videoinput");
  const audioOutputDevices = mediaDevices.filter((device) => device.kind === "audiooutput");
  const localTileId = "local";
  const videoTiles = [
    {
      id: localTileId,
      stream: localPreviewStream,
      voiceStream: null,
      screenAudioStream: null,
      label: localPreviewLabel,
      avatarUrl: currentUser?.avatarUrl ?? "",
      muted: true,
      active: localVideoVisible,
      micOn: micOn && isConnected,
      cameraOn: localVideoVisible,
      connectionLabel,
      isSpeaking: isSpeaking && micOn && isConnected,
      audioOutputId: "",
      volume: 0,
      liveVolume: 0,
      canControlVolume: false,
      canControlLiveVolume: false,
      isScreenShare: Boolean(screenStream),
    },
    ...connectedRemotePeers.map((peer) => ({
      id: peer.id,
      stream: peer.stream,
      voiceStream: peer.voiceStream,
      screenAudioStream: peer.screenAudioStream,
      label: peer.screenOn ? `${peer.name} (tela)` : peer.name,
      avatarUrl: peer.avatarUrl,
      muted: audioMuted,
      active: Boolean(peer.stream && (peer.cameraOn || peer.screenOn) && peer.stream.getVideoTracks().some((track) => track.readyState === "live")),
      micOn: peer.micOn,
      cameraOn: peer.cameraOn || peer.screenOn,
      connectionLabel: peer.stream ? "Conectado" : "Conectando",
      isSpeaking: false,
      audioOutputId: deviceSelections.audioOutputId,
      volume: peerVoiceVolumes[peer.id] ?? 1,
      liveVolume: peerLiveVolumes[peer.id] ?? 1,
      canControlVolume: Boolean(peer.voiceStream),
      canControlLiveVolume: Boolean(peer.screenAudioStream),
      isScreenShare: peer.screenOn,
    })),
  ];
  const spotlightTile = videoTiles.find((tile) => tile.id === spotlightId && tile.active) ?? null;
  const gridTiles = spotlightTile ? videoTiles.filter((tile) => tile.id !== spotlightTile.id) : videoTiles;
  const voiceParticipants = [
    ...(isConnected ? [{ id: clientId || "local", name: visibleName, avatarUrl: currentUser?.avatarUrl ?? "", isLocal: true, hasVoice: false, hasLive: false }] : []),
    ...connectedRemotePeers.map((peer) => ({
      id: peer.id,
      name: peer.name,
      avatarUrl: peer.avatarUrl,
      isLocal: false,
      hasVoice: Boolean(peer.voiceStream),
      hasLive: Boolean(peer.screenAudioStream),
    })),
  ];

  if (!isReady) {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-label="Carregando Sharetalk">
          <div className="auth-brand">
            <div className="server-mark">ST</div>
            <div>
              <span>{APP_NAME}</span>
              <h1>Carregando</h1>
            </div>
          </div>
        </section>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-label="Entrar no Sharetalk">
          <div className="auth-brand">
            <div className="server-mark">ST</div>
            <div>
              <span>{APP_NAME}</span>
              <h1>{authMode === "register" ? "Criar conta" : "Entrar"}</h1>
            </div>
          </div>
          <form className="auth-form" onSubmit={handleAuthSubmit}>
            <label htmlFor="auth-user">Usuario</label>
            <input
              id="auth-user"
              value={authUsername}
              onChange={(event) => setAuthUsername(event.target.value)}
              placeholder="seu.usuario"
              autoComplete="username"
            />
            {authMode === "register" ? (
              <>
                <label htmlFor="auth-display">Nome no servidor</label>
                <input
                  id="auth-display"
                  value={authDisplayName}
                  onChange={(event) => setAuthDisplayName(event.target.value)}
                  placeholder="Como voce quer aparecer"
                  autoComplete="name"
                />
                <label htmlFor="auth-avatar">Foto de perfil</label>
                <div className="avatar-edit-row">
                  <ProfileAvatar name={authDisplayName || authUsername || "Amigo"} avatarUrl={authAvatarUrl} />
                  <input id="auth-avatar" type="file" accept="image/*" onChange={handleAuthAvatarChange} />
                </div>
              </>
            ) : null}
            <label htmlFor="auth-password">Senha</label>
            <input
              id="auth-password"
              type="password"
              value={authPassword}
              onChange={(event) => setAuthPassword(event.target.value)}
              placeholder="Sua senha"
              autoComplete={authMode === "register" ? "new-password" : "current-password"}
            />
            {authError ? <p className="auth-error">{authError}</p> : null}
            <button type="submit" className="primary-button">
              {authMode === "register" ? "Criar e entrar" : "Entrar no servidor"}
            </button>
          </form>
          <button
            type="button"
            className="auth-switch"
            onClick={() => {
              setAuthMode((mode) => mode === "register" ? "login" : "register");
              setAuthError("");
            }}
          >
            {authMode === "register" ? "Ja tenho conta" : "Criar nova conta"}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <nav className="server-rail" aria-label="Servidor fixo">
        <div className="server-mark" title={APP_NAME}>ST</div>
      </nav>

      <aside className="channel-sidebar" aria-label="Canais do servidor">
        <div className="server-header">
          <span>Servidor</span>
          <strong>{SERVER_DISPLAY_NAME}</strong>
        </div>

        <section className="channel-section" aria-label="Canais de texto">
          <div className="channel-heading">
            <span>Texto</span>
            <button type="button" onClick={() => createChannel("text")} aria-label="Criar canal de texto" title="Criar canal de texto">+</button>
          </div>
          {textChannels.map((channel) => (
            <div className="channel-row" key={channel.id}>
              <button
                type="button"
                className={`channel-button ${selectedTextChannel === channel.id ? "is-selected" : ""}`}
                onClick={() => switchTextChannel(channel.id)}
              >
                <span>#</span>
                {channel.name}
              </button>
              <div className="channel-actions" aria-label={`Acoes do canal ${channel.name}`}>
                <button type="button" onClick={() => renameChannel(channel)} aria-label={`Editar canal ${channel.name}`} title="Editar">E</button>
                <button type="button" onClick={() => removeChannel(channel)} aria-label={`Remover canal ${channel.name}`} title="Remover">x</button>
              </div>
            </div>
          ))}
        </section>

        <section className="channel-section" aria-label="Canais de voz">
          <div className="channel-heading">
            <span>Voz</span>
            <button type="button" onClick={() => createChannel("voice")} aria-label="Criar canal de voz" title="Criar canal de voz">+</button>
          </div>
          {voiceChannels.map((channel) => (
            <div className="voice-channel-group" key={channel.id}>
              <div className="channel-row">
                <button
                  type="button"
                  className={`channel-button voice-channel ${selectedVoiceChannel === channel.id ? "is-selected" : ""}`}
                  onClick={() => switchVoiceChannel(channel.id)}
                >
                  <span>◉</span>
                  {channel.name}
                </button>
                <div className="channel-actions" aria-label={`Acoes do canal ${channel.name}`}>
                  <button type="button" onClick={() => renameChannel(channel)} aria-label={`Editar canal ${channel.name}`} title="Editar">E</button>
                  <button type="button" onClick={() => removeChannel(channel)} aria-label={`Remover canal ${channel.name}`} title="Remover">x</button>
                </div>
              </div>
              {selectedVoiceChannel === channel.id && voiceParticipants.length > 0 ? (
                <div className="voice-participants">
                  {voiceParticipants.map((participant) => (
                    <div className="voice-participant" key={participant.id}>
                      <ProfileAvatar name={participant.name} avatarUrl={participant.avatarUrl} />
                      <div className="voice-participant-body">
                        <p>{participant.name}{participant.isLocal ? " (voce)" : ""}</p>
                        {!participant.isLocal && (participant.hasVoice || participant.hasLive) ? (
                          <div className="participant-volumes">
                            {participant.hasVoice ? (
                              <label>
                                <small>Voz</small>
                                <input
                                  type="range"
                                  min="0"
                                  max="1"
                                  step="0.01"
                                  value={peerVoiceVolumes[participant.id] ?? 1}
                                  onChange={(event) => setPeerVoiceVolumes((items) => ({ ...items, [participant.id]: Number(event.target.value) }))}
                                  aria-label={`Volume da voz de ${participant.name}`}
                                />
                                <b>{Math.round((peerVoiceVolumes[participant.id] ?? 1) * 100)}</b>
                              </label>
                            ) : null}
                            {participant.hasLive ? (
                              <label>
                                <small>Live</small>
                                <input
                                  type="range"
                                  min="0"
                                  max="1"
                                  step="0.01"
                                  value={peerLiveVolumes[participant.id] ?? 1}
                                  onChange={(event) => setPeerLiveVolumes((items) => ({ ...items, [participant.id]: Number(event.target.value) }))}
                                  aria-label={`Volume da live de ${participant.name}`}
                                />
                                <b>{Math.round((peerLiveVolumes[participant.id] ?? 1) * 100)}</b>
                              </label>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
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
            <h1>{SERVER_DISPLAY_NAME}</h1>
          </div>
        </header>

        <div className="stage-area">
          {spotlightTile ? (
            <VideoTile
              key={`spotlight-${spotlightTile.id}`}
              stream={spotlightTile.stream}
              voiceStream={spotlightTile.voiceStream}
              screenAudioStream={spotlightTile.screenAudioStream}
              label={spotlightTile.label}
              avatarUrl={spotlightTile.avatarUrl}
              muted={spotlightTile.muted}
              active={spotlightTile.active}
              micOn={spotlightTile.micOn}
              cameraOn={spotlightTile.cameraOn}
              connectionLabel={spotlightTile.connectionLabel}
              isSpeaking={spotlightTile.isSpeaking}
              audioOutputId={spotlightTile.audioOutputId}
              volume={spotlightTile.volume}
              liveVolume={spotlightTile.liveVolume}
              isScreenShare={spotlightTile.isScreenShare}
              isSpotlight
              isSelected
            />
          ) : null}

          <div className={`video-grid ${spotlightTile ? "has-spotlight" : ""}`}>
            {gridTiles.map((tile) => (
              <VideoTile
                key={`${tile.id}-${tile.id === localTileId && screenStream ? "screen" : "camera"}`}
                stream={tile.stream}
                voiceStream={tile.voiceStream}
                screenAudioStream={tile.screenAudioStream}
                label={tile.label}
                avatarUrl={tile.avatarUrl}
                muted={tile.muted}
                active={tile.active}
                micOn={tile.micOn}
                cameraOn={tile.cameraOn}
                connectionLabel={tile.connectionLabel}
                isSpeaking={tile.isSpeaking}
                audioOutputId={tile.audioOutputId}
                volume={tile.volume}
                liveVolume={tile.liveVolume}
                isScreenShare={tile.isScreenShare}
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

      </section>

      <aside className="side-panel" aria-label="Chat e servidor">
        <section className="voice-card" aria-label="Resumo do canal de voz">
          <div className="voice-card-header">
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
          </div>
          <div className="status-pills side-status-pills" aria-label="Status da chamada">
            <span className={`status-pill ${isConnected ? "is-online" : "is-offline"}`}>
              {connectionLabel}
            </span>
            <span className={`status-pill ${micOn && isConnected ? "is-online" : "is-muted"}`}>
              Mic {micOn && isConnected ? "ligado" : "mudo"}
            </span>
            <span className={`status-pill ${cameraOn && isConnected ? "is-online" : "is-muted"}`}>
              Cam {cameraOn && isConnected ? "ligada" : "pausada"}
            </span>
            <span className={`status-pill ${screenStream ? "is-online" : "is-muted"}`}>
              Tela {screenStream ? "ativa" : "parada"}
            </span>
          </div>
          {!isConnected ? (
            <button type="button" className="primary-button side-join" onClick={joinCall} disabled={!isReady}>
              Entrar no canal
            </button>
          ) : (
            <div className="side-controls" aria-label="Controles da chamada">
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
          )}
          <div className="side-status-line" role={error ? "alert" : "status"}>
            {error || status}
          </div>
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

        <section className="profile-card" aria-label="Perfil do usuario">
          <div className="profile-summary">
            <ProfileAvatar name={currentUser.displayName} avatarUrl={currentUser.avatarUrl} />
            <div>
              <strong>{currentUser.displayName}</strong>
              <span>@{currentUser.username}</span>
            </div>
            <button type="button" onClick={() => setProfileOpen((value) => !value)}>
              {profileOpen ? "Fechar" : "Editar"}
            </button>
          </div>
          {profileOpen ? (
            <form className="profile-form" onSubmit={saveProfile}>
              <label htmlFor="profile-name">Nome no servidor</label>
              <input
                id="profile-name"
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                placeholder="Seu nome"
              />
              <label htmlFor="profile-avatar">Foto de perfil</label>
              <div className="avatar-edit-row">
                <ProfileAvatar name={profileName || currentUser.displayName} avatarUrl={profileAvatarUrl} />
                <input id="profile-avatar" type="file" accept="image/*" onChange={handleProfileAvatarChange} />
              </div>
              <div className="profile-actions">
                <button type="submit" className="primary-button">Salvar perfil</button>
                <button type="button" onClick={logout}>Sair</button>
              </div>
            </form>
          ) : null}
        </section>

        <section className="chat-panel" aria-label="Chat persistente">
          <div className="chat-head">
            <h2>#{currentTextChannel.name}</h2>
            <span>{messages.length} mensagens</span>
          </div>
          <div className="messages" ref={messagesRef}>
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

function ProfileAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  return (
    <span className="profile-avatar" aria-hidden="true">
      {avatarUrl ? <img src={avatarUrl} alt="" /> : avatarInitial(name)}
    </span>
  );
}

function VideoTile({
  stream,
  voiceStream,
  screenAudioStream,
  label,
  avatarUrl = "",
  muted = false,
  active,
  micOn,
  cameraOn,
  connectionLabel,
  isSpeaking = false,
  audioOutputId = "",
  volume = 1,
  liveVolume = 1,
  isScreenShare = false,
  isSpotlight = false,
  isSelected = false,
  onSelect,
}: {
  stream: MediaStream | null;
  voiceStream?: MediaStream | null;
  screenAudioStream?: MediaStream | null;
  label: string;
  avatarUrl?: string;
  muted?: boolean;
  active: boolean;
  micOn: boolean;
  cameraOn: boolean;
  connectionLabel: string;
  isSpeaking?: boolean;
  audioOutputId?: string;
  volume?: number;
  liveVolume?: number;
  isScreenShare?: boolean;
  isSpotlight?: boolean;
  isSelected?: boolean;
  onSelect?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const screenAudioRef = useRef<HTMLAudioElement | null>(null);
  const tileRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(() => undefined);
    }
    if (voiceAudioRef.current) {
      voiceAudioRef.current.srcObject = voiceStream ?? null;
      voiceAudioRef.current.play().catch(() => undefined);
    }
    if (screenAudioRef.current) {
      screenAudioRef.current.srcObject = screenAudioStream ?? null;
      screenAudioRef.current.play().catch(() => undefined);
    }
  }, [stream, voiceStream, screenAudioStream]);

  useEffect(() => {
    const audioElements = [voiceAudioRef.current, screenAudioRef.current] as Array<(HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    }) | null>;

    audioElements.forEach((audio) => {
      if (audio?.setSinkId) {
        audio.setSinkId(audioOutputId).catch(() => undefined);
      }
    });
  }, [audioOutputId]);

  useEffect(() => {
    if (voiceAudioRef.current) {
      voiceAudioRef.current.volume = Math.max(0, Math.min(1, volume));
    }
  }, [volume]);

  useEffect(() => {
    if (screenAudioRef.current) {
      screenAudioRef.current.volume = Math.max(0, Math.min(1, liveVolume));
    }
  }, [liveVolume]);

  function openFullscreen(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    tileRef.current?.requestFullscreen?.().catch(() => undefined);
  }

  return (
    <div
      ref={tileRef}
      className={`video-tile ${active ? "is-active" : ""} ${isScreenShare ? "is-screen-share" : ""} ${isSpeaking ? "is-speaking" : ""} ${isSpotlight ? "is-spotlight" : ""} ${isSelected ? "is-selected" : ""} ${onSelect ? "is-selectable" : ""}`}
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
      <audio ref={voiceAudioRef} autoPlay muted={muted} />
      <audio ref={screenAudioRef} autoPlay muted={muted} />
      {!active ? (
        <div className="avatar-fallback">
          <ProfileAvatar name={label} avatarUrl={avatarUrl} />
        </div>
      ) : null}
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

