import { mount } from 'svelte';
import './styles/global.css';
import App from './App.svelte';
import { initializeTheme } from './lib/theme';

initializeTheme();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
