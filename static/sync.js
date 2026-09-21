// Stream sync over BroadcastChannel('goldfish').
import { serializeForStream } from './state.js';

const channel = new BroadcastChannel('goldfish');

// Player window: call after every reduce (and on modal open/close) with the full
// (unredacted) local state. ui = null | {kind:'trash'} | {kind:'deck', n:null|number}.
export function publish(state, ui) {
  if (!state) return;
  channel.postMessage({ type: 'state', state: serializeForStream(state), ui: ui || null });
}

// Player window: invoke callback whenever a stream window asks for the current state.
export function onHello(callback) {
  channel.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'hello') callback();
  });
}

// Stream window: invoke callback with (redacted state, ui) whenever the player publishes.
export function onState(callback) {
  channel.addEventListener('message', (ev) => {
    if (ev.data && ev.data.type === 'state') callback(ev.data.state, ev.data.ui || null);
  });
}

// Stream window: announce presence on load so the player replies with current state.
export function sendHello() {
  channel.postMessage({ type: 'hello' });
}
