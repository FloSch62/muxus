import { claimInstance } from './instance.js';
import { initialCommandLineLaunch } from './command-line.js';
import { userDataPath } from './paths.js';

// Lives beside Electrobun's native main thread, which blocks in the native event
// loop. This worker must claim the instance before that loop starts.
const channel = new BroadcastChannel('muxus-instance');
let ready = false;
const pending: Array<string | undefined> = [];
const instance = await claimInstance(userDataPath(), JSON.stringify(initialCommandLineLaunch()), (link) => {
  if (ready) channel.postMessage({ type: 'activate', link });
  else pending.push(link);
});
channel.onmessage = (event: MessageEvent<{ type: string }>) => {
  if (event.data.type === 'ready') {
    ready = true;
    for (const link of pending.splice(0)) channel.postMessage({ type: 'activate', link });
  } else if (event.data.type === 'shutdown') {
    instance?.close();
    channel.close();
  }
};
postMessage({ claimed: !!instance });
