import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createWebRoomGateway } from './data/webRoomGateway';
import type { RoomGateway } from './data/RoomGateway';
import './styles.css';

let gateway: RoomGateway | undefined;
let configurationError = '';
try {
  gateway = createWebRoomGateway();
} catch {
  configurationError = '页面配置不完整，请核对 CloudBase 环境变量后重试。';
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');

createRoot(root).render(
  <StrictMode>
    <App gateway={gateway} configurationError={configurationError} />
  </StrictMode>,
);
