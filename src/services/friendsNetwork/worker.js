import { createFriendsNetworkWorkerController } from './controller';

// This worker owns the session cache and all CPU-heavy history/graph work.
// It uses ordinary structured-clone messages and has no access to the database.
const controller = createFriendsNetworkWorkerController((message) => self.postMessage(message));
self.addEventListener('message', ({ data }) => {
    void controller.handle(data);
});
