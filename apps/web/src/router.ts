import { createRouter, createWebHistory } from 'vue-router';

import PlaceholderView from './views/PlaceholderView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/pos/pos-1' },
    { path: '/pos/:terminalId', name: 'pos', component: PlaceholderView },
    { path: '/kitchen', name: 'kitchen', component: PlaceholderView },
    { path: '/debug', name: 'debug', component: PlaceholderView },
    { path: '/demo', name: 'demo', component: PlaceholderView },
  ],
});
