const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// Sert les fichiers statiques (ton HTML)
app.use(express.static('public'));

io.on('connection', (socket) => {
  console.log('Un joueur est connecté: ' + socket.id);
  
  socket.on('jouerCarte', (data) => {
    // Transmet l'action à tous les autres joueurs
    io.emit('carteJouee', data);
  });
});

http.listen(3000, () => {
  console.log('Serveur Gang of Four en ligne sur le port 3000');
});
