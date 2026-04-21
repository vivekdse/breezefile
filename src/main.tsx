import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ornaments.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
