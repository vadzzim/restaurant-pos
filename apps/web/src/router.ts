import { createRouter, createWebHistory } from 'vue-router';

import KitchenView from './views/KitchenView.vue';
import PlaceholderView from './views/PlaceholderView.vue';
import PosView from './views/PosView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/pos/pos-1' },
    { path: '/pos/:terminalId', name: 'pos', component: PosView },
    { path: '/kitchen', name: 'kitchen', component: KitchenView },
    // /debug is M11 and /demo is M16; the M1 placeholder keeps the navigation honest until then.
    { path: '/debug', name: 'debug', component: PlaceholderView },
    { path: '/demo', name: 'demo', component: PlaceholderView },
  ],
});
