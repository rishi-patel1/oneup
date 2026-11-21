import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { AccountProvider } from './account/AccountProvider';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><AccountProvider><App /></AccountProvider></React.StrictMode>,
);
