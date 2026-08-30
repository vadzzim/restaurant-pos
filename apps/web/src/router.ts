import { createRouter, createWebHistory } from 'vue-router';

import DebugView from './views/DebugView.vue';
import DemoView from './views/DemoView.vue';
import KitchenView from './views/KitchenView.vue';
import PosView from './views/PosView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/pos/pos-1' },
    { path: '/pos/:terminalId', name: 'pos', component: PosView },
    { path: '/kitchen', name: 'kitchen', component: KitchenView },
    { path: '/debug', name: 'debug', component: DebugView },
    { path: '/demo', name: 'demo', component: DemoView },
  ],
});
