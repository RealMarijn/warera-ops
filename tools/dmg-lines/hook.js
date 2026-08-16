// WarEra Damage lines — MAIN-world hook.
//
// Runs at document_start, BEFORE the game's own bundle evaluates, so it can
// replace window.WebSocket before the app captures a reference to it. WarEra
// pushes all real-time battle damage over a single long-lived Centrifugo
// WebSocket; we tap every message and forward battle hits to the overlay
// (which lives in the ISOLATED world) via window.postMessage.
//
// Centrifugo frame shape we care about (frames can be newline-joined):
//   {"push":{"channel":"battle:<battleId>","pub":{"data":{
//        "type":"new_hit","side":"attacker"|"defender","damages":192, ... }}}}
(() => {
  "use strict";

  const CHANNEL = "warera-dmg-lines"; // postMessage discriminator
  try { document.documentElement.dataset.wdlHook = "0.4.0"; } catch (_) {}
  console.log("[WDL] hook.js v0.4.0 (lasthit) loaded");

  const post = (msg) => {
    try {
      window.postMessage({ __wdl: CHANNEL, ...msg }, window.location.origin);
    } catch (_) {
      /* ignore */
    }
  };

  const handleFrame = (frame) => {
    const push = frame && frame.push;
    const channel = push && push.channel;
    const data = push && push.pub && push.pub.data;
    if (!channel || !data || data.type !== "new_hit") return;

    if (channel.startsWith("battleLastHits:")) {
      // Per-hit detail incl. the player (`user`) that dealt it — this is what
      // lets us attribute damage to the player's *country*.
      const lh = data.lastHit || {};
      post({
        kind: "lasthit",
        battleId: channel.slice("battleLastHits:".length),
        side: data.side, // side the hit was dealt for: "attacker" | "defender"
        user: lh.user,
        damages: Number(lh.damages) || 0,
      });
    } else if (channel.startsWith("battle:")) {
      // Aggregate hit — accurate per-side totals/rate, independent of user detail.
      post({
        kind: "hit",
        battleId: channel.slice("battle:".length),
        side: data.side,
        damages: Number(data.damages) || 0,
      });
    }
  };

  const onMessage = (event) => {
    const raw = event && event.data;
    if (typeof raw !== "string") return; // binary/ping frames: ignore
    // A single WS message may contain several newline-separated JSON frames.
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch (_) {
        continue;
      }
      handleFrame(frame);
    }
  };

  const OriginalWebSocket = window.WebSocket;
  if (!OriginalWebSocket) return;

  // Proxy the constructor so instanceof, static constants, name and prototype
  // are all preserved, and we simply attach an extra passive message listener.
  window.WebSocket = new Proxy(OriginalWebSocket, {
    construct(Target, args) {
      const socket = Reflect.construct(Target, args);
      try {
        socket.addEventListener("message", onMessage);
      } catch (_) {
        /* ignore */
      }
      return socket;
    },
  });
})();
