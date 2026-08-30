import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { registerServiceWorker } from './pwa/register';
import { router } from './router';
import './styles.css';

createApp(App).use(createPinia()).use(router).mount('#app');

registerServiceWorker();
