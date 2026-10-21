/**
 * Co-presence layout only. The existing mutual-friends layout worker is unchanged.
 *
 * Layout/cancel requests carry requestId. Drag requests add type:'drag', phase
 * and held node positions. The settled reply includes nodeIds in buffer order.
 * Live replies transfer Float64Array x/y pairs until the drag settles or cancels.
 */
import { createFriendsNetworkLayoutController } from './friendsNetworkLayout';

const controller = createFriendsNetworkLayoutController((message, transfer = []) =>
    self.postMessage(message, { transfer })
);
self.addEventListener('message', ({ data }) => {
    void controller.handle(data);
});
