const { io } = require('socket.io-client');

const socket = io('http://localhost:3000/dashboard', {
  auth: { token: '<your-test-jwt-with-admin-role>' },
});

socket.on('connect', () => {
  console.log('Connected:', socket.id);
  socket.emit('subscribe:firehose');
});

socket.on('subscribed', (data) => console.log('Subscribed:', data));
socket.on('notification:state', (event) => console.log('State change:', event));
socket.on('connect_error', (err) => console.log('Connect error:', err.message));
