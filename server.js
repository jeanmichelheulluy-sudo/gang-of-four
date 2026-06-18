const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// --- ÉTAT DU JEU CENTRALISÉ ---
let connexions = []; // Liste des socket.id des humains
let config = { nbHumains: 2, prepra: true }; // Par défaut 2 humains
let partieEnCours = false;

let mains = [[], [], [], []]; 
let typesJoueurs = ['ia', 'ia', 'ia', 'ia']; // 'humain' ou 'ia'
let scoresGlobaux = [0, 0, 0, 0];
let etatTable = null;
let joueurActif = 0;
let nbPassesCons = 0;
let maitreDuPli = 0;

const couleurs = ['Vert', 'Jaune', 'Rouge'];

function genererPaquet() {
    let paquet = [];
    for (let c of couleurs) {
        for (let v = 1; v <= 10; v++) {
            paquet.push({ valeurSort: v, rang: v, couleur: c, type: 'Normal' });
            paquet.push({ valeurSort: v, rang: v, couleur: c, type: 'Normal' });
        }
    }
    paquet.push({ valeurSort: 1.5, rang: 1, couleur: 'Special', classe: 'Multi', type: 'Special', display: '1' });
    paquet.push({ valeurSort: 11, rang: 11, couleur: 'Vert', classe: 'PhenixV', type: 'Special', display: 'V' });
    paquet.push({ valeurSort: 11.5, rang: 11, couleur: 'Jaune', classe: 'PhenixJ', type: 'Special', display: 'J' });
    paquet.push({ valeurSort: 12, rang: 12, couleur: 'Rouge', classe: 'Dragon', type: 'Special', display: '🐉' });
    return paquet;
}

function trierCartes(main) {
    const ordreCouleurs = { 'Vert': 1, 'Jaune': 2, 'Rouge': 3, 'Special': 4 };
    return main.sort((a, b) => (a.valeurSort - b.valeurSort) || (ordreCouleurs[a.couleur] - ordreCouleurs[b.couleur]));
}

function getPuissanceCarte(rang, couleur) {
    const poidsCouleur = { 'Vert': 0.1, 'Jaune': 0.2, 'Rouge': 0.3, 'Special': 0.4 };
    return rang + (poidsCouleur[couleur] || 0);
}

function analyserCombinaison(cartesJouees) {
    let nb = cartesJouees.length;
    if (nb === 0) return null;

    let combo = { nom: "", format: 0, puissance: 0, isGang: false };
    let rangBase = cartesJouees[0].rang;
    let estIdentique = cartesJouees.every(c => c.rang === rangBase);

    // GANGS (4 à 7 cartes identiques)
    if (estIdentique && nb >= 4) {
        combo.format = nb;
        combo.puissance = (nb * 100) + rangBase; 
        combo.nom = "🔥 GANG OF " + nb + " 🔥";
        combo.isGang = true;
        return combo;
    }

    // COMBINAISONS CLASSIQUES (1, 2, 3 identiques)
    if (estIdentique && nb < 4) {
        combo.format = nb;
        let cartePlusForte = cartesJouees[0];
        cartesJouees.forEach(c => {
            if(getPuissanceCarte(c.rang, c.couleur) > getPuissanceCarte(cartePlusForte.rang, cartePlusForte.couleur)) cartePlusForte = c;
        });
        combo.puissance = getPuissanceCarte(cartePlusForte.rang, cartePlusForte.couleur);
        combo.nom = (nb === 1) ? "Carte Seule" : (nb === 2) ? "Paire" : "Brelan";
        return combo;
    }

    // COMBINAISONS DE 5 CARTES
    if (nb === 5) {
        let contientSpecial = cartesJouees.some(c => c.type === 'Special');
        if (contientSpecial) return null;

        let cartesTriees = [...cartesJouees].sort((a,b) => a.rang - b.rang);
        let isSuite = true;
        for(let i = 1; i < 5; i++) { if (cartesTriees[i].rang !== cartesTriees[i-1].rang + 1) isSuite = false; }
        let isCouleur = cartesJouees.every(c => c.couleur === cartesJouees[0].couleur);
        let isFull = (cartesTriees[0].rang === cartesTriees[2].rang && cartesTriees[3].rang === cartesTriees[4].rang) ||
                     (cartesTriees[0].rang === cartesTriees[1].rang && cartesTriees[2].rang === cartesTriees[4].rang);

        combo.format = 5;
        let carteMax = cartesTriees[4];

        if (isSuite && isCouleur) {
            combo.nom = "🌟 QUINTE FLUSH 🌟";
            combo.puissance = 300 + getPuissanceCarte(carteMax.rang, carteMax.couleur);
            combo.isGang = false; // DEMANDE UTILISATEUR : CE N'EST PAS UN GANG
            return combo;
        }
        if (isFull) {
            combo.nom = "Full";
            combo.puissance = 200 + cartesTriees[2].rang;
            return combo;
        }
        if (isCouleur) {
            combo.nom = "Couleur";
            combo.puissance = 100 + getPuissanceCarte(carteMax.rang, carteMax.couleur);
            return combo;
        }
        if (isSuite) {
            combo.nom = "Suite";
            combo.puissance = getPuissanceCarte(carteMax.rang, carteMax.couleur);
            return combo;
        }
    }
    return null;
}

function demarrerNouvelleManche() {
    let paquet = genererPaquet();
    for (let i = paquet.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        let temp = paquet[i]; paquet[i] = paquet[j]; paquet[j] = temp;
    }

    for (let i = 0; i < 4; i++) {
        mains[i] = trierCartes(paquet.slice(i * 16, (i + 1) * 16));
    }

    etatTable = null;
    nbPassesCons = 0;
    maitreDuPli = 0;
    joueurActif = 0;
    partieEnCours = true;

    synchroniserToutLeMonde();
    verifierTourIA();
}

function synchroniserToutLeMonde() {
    for (let i = 0; i < 4; i++) {
        if (typesJoueurs[i] === 'humain' && connexions[i]) {
            io.to(connexions[i]).emit('etatPartie', {
                votreIndex: i,
                maMain: mains[i],
                joueurActif: joueurActif,
                etatTable: etatTable,
                taillesMains: mains.map(m => m.length),
                scoresGlobaux: scoresGlobaux,
                typesJoueurs: typesJoueurs,
                nbPassesCons: nbPassesCons
            });
        }
    }
}

function verifierTourIA() {
    if (!partieEnCours) return;
    if (typesJoueurs[joueurActif] === 'ia') {
        setTimeout(faireJouerIA, 1500);
    }
}

function faireJouerIA() {
    let mainIA = mains[joueurActif];
    let aJoue = false;
    let comboA_Jouer = [];

    if (etatTable === null) {
        // Ouverture simple : joue la plus petite carte seule
        comboA_Jouer = [mainIA[0]];
    } else {
        // Riposte simple : cherche une carte seule plus forte
        if (etatTable.format === 1) {
            for (let i = 0; i < mainIA.length; i++) {
                let c = mainIA[i];
                if (getPuissanceCarte(c.rang, c.couleur) > etatTable.puissance) {
                    comboA_Jouer = [c];
                    break;
                }
            }
        }
    }

    if (comboA_Jouer.length > 0) {
        let info = analyserCombinaison(comboA_Jouer);
        if (info) {
            comboA_Jouer.forEach(c => {
                let idx = mainIA.findIndex(m => m.valeurSort === c.valeurSort && m.couleur === c.couleur);
                if (idx > -1) mainIA.splice(idx, 1);
            });
            etatTable = info;
            etatTable.cartes = comboA_Jouer;
            etatTable.nomProprio = `IA ${joueurActif}`;
            nbPassesCons = 0;
            maitreDuPli = joueurActif;
            aJoue = true;
        }
    }

    if (!aJoue) {
        nbPassesCons++;
    }

    if (mainIA.length === 0) {
        partieTerminee(joueurActif);
        return;
    }

    passerAuJoueurSuivant();
}

function passerAuJoueurSuivant() {
    if (nbPassesCons >= 3) {
        etatTable = null;
        nbPassesCons = 0;
        joueurActif = maitreDuPli;
    } else {
        joueurActif = (joueurActif + 1) % 4;
    }
    synchroniserToutLeMonde();
    verifierTourIA();
}

function partieTerminee(gagnant) {
    partieEnCours = false;
    let penalites = mains.map(m => {
        let n = m.length;
        if (n === 0) return 0;
        if (n <= 7) return n;
        if (n <= 9) return n * 2;
        if (n <= 15) return n * 3;
        return n * 4;
    });

    for(let i=0; i<4; i++) scoresGlobaux[i] += penalites[i];

    io.emit('finManche', {
        gagnant: gagnant,
        penalites: penalites,
        scoresGlobaux: scoresGlobaux
    });
}

// --- GESTION DES JOUEURS CONNECTÉS ---
io.on('connection', (socket) => {
    console.log('Connexion d\'un appareil : ' + socket.id);

    // Le premier joueur devient le Host (Chef de table)
    if (connexions.length === 0) {
        socket.emit('statutHote', true);
    } else {
        socket.emit('statutHote', false);
    }

socket.on('configurerPartie', (data) => {
        config.nbHumains = parseInt(data.nbHumains);
        // Assigner les places
        connexions = [socket.id];
        typesJoueurs = ['humain', 'ia', 'ia', 'ia'];
        
        for(let i=1; i < config.nbHumains; i++) {
            typesJoueurs[i] = 'humain'; // En attente de vrais joueurs
        }

        // CORRECTION : Si on a choisi 1 seul humain, on lance tout de suite !
        if (connexions.length === config.nbHumains) {
            demarrerNouvelleManche();
        } else {
            io.emit('attenteJoueurs', { connectes: connexions.length, requis: config.nbHumains });
        }
    });

    socket.on('rejoindrePartie', () => {
        if (connexions.length < config.nbHumains && !connexions.includes(socket.id)) {
            connexions.push(socket.id);
            io.emit('attenteJoueurs', { connectes: connexions.length, requis: config.nbHumains });

            if (connexions.length === config.nbHumains) {
                demarrerNouvelleManche();
            }
        }
    });

    socket.on('actionJouer', (cartesSelectionnees) => {
        let monIndex = connexions.indexOf(socket.id);
        if (monIndex !== joueurActif) return;

        let info = analyserCombinaison(cartesSelectionnees);
        if (!info) { socket.emit('erreur', 'Combinaison invalide !'); return; }

        if (etatTable !== null) {
            if (info.isGang) {
                if (etatTable.isGang && info.puissance <= etatTable.puissance) { socket.emit('erreur', 'Ton Gang est trop faible !'); return; }
            } else {
                if (etatTable.isGang) { socket.emit('erreur', 'Il te faut un Gang pour couper !'); return; }
                if (info.format !== etatTable.format) { socket.emit('erreur', 'Format incorrect.'); return; }
                if (info.puissance <= etatTable.puissance) { socket.emit('erreur', 'Combinaison trop faible.'); return; }
            }
        }

        // Retirer les cartes de la main
        cartesSelectionnees.forEach(c => {
            let idx = mains[monIndex].findIndex(m => m.valeurSort === c.valeurSort && m.couleur === c.couleur);
            if (idx > -1) mains[monIndex].splice(idx, 1);
        });

        etatTable = info;
        etatTable.cartes = cartesSelectionnees;
        etatTable.nomProprio = `Joueur ${monIndex + 1}`;
        nbPassesCons = 0;
        maitreDuPli = monIndex;

        if (mains[monIndex].length === 0) {
            partieTerminee(monIndex);
            return;
        }

        passerAuJoueurSuivant();
    });

    socket.on('actionPasser', () => {
        let monIndex = connexions.indexOf(socket.id);
        if (monIndex !== joueurActif) return;
        if (etatTable === null) { socket.emit('erreur', 'Tu dois ouvrir le pli !'); return; }

        nbPassesCons++;
        passerAuJoueurSuivant();
    });

    socket.on('demandeNouvelleManche', () => {
        demarrerNouvelleManche();
    });

    socket.on('disconnect', () => {
        connexions = connexions.filter(id => id !== socket.id);
        io.emit('attenteJoueurs', { connectes: connexions.length, requis: config.nbHumains });
    });
});

http.listen(3000, () => {
    console.log('Serveur Arbitre Gang of Four en ligne sur le port 3000');
});
