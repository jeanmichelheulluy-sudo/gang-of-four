const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

let connexions = []; 
let config = { nbHumains: 2 }; 
let partieEnCours = false;

let mains = [[], [], [], []]; 
let typesJoueurs = ['ia', 'ia', 'ia', 'ia']; 
let nomsJoueurs = ['IA 1', 'IA 2', 'IA 3', 'IA 4'];
let scoresGlobaux = [0, 0, 0, 0];
let etatTable = null;
let joueurActif = 0;
let nbPassesCons = 0;
let maitreDuPli = 0;

let dernierGagnant = null;
let dernierPerdant = null;
let phaseEchange = false;

const couleurs = ['Vert', 'Jaune', 'Rouge'];

function genererPaquet() {
    let paquet = [];
    let idCounter = 0;
    for (let c of couleurs) {
        for (let v = 1; v <= 10; v++) {
            paquet.push({ id: `c_${idCounter++}`, valeurSort: v, rang: v, couleur: c, type: 'Normal' });
            paquet.push({ id: `c_${idCounter++}`, valeurSort: v, rang: v, couleur: c, type: 'Normal' });
        }
    }
    paquet.push({ id: `c_${idCounter++}`, valeurSort: 1.5, rang: 1, couleur: 'Special', classe: 'Multi', type: 'Special', display: '1' });
    paquet.push({ id: `c_${idCounter++}`, valeurSort: 11, rang: 11, couleur: 'Vert', classe: 'PhenixV', type: 'Special', display: '🦅' });
    paquet.push({ id: `c_${idCounter++}`, valeurSort: 11.5, rang: 11, couleur: 'Jaune', classe: 'PhenixJ', type: 'Special', display: '🦅' });
    paquet.push({ id: `c_${idCounter++}`, valeurSort: 12, rang: 12, couleur: 'Rouge', classe: 'Dragon', type: 'Special', display: '🐉' });
    return paquet;
}

function trierCartes(main) {
    const ordreCouleurs = { 'Vert': 1, 'Jaune': 2, 'Rouge': 3, 'Special': 4 };
    return main.sort((a, b) => (a.valeurSort - b.valeurSort) || (ordreCouleurs[a.couleur] - ordreCouleurs[b.couleur]));
}

function getPuissanceCarte(rang, couleur, classe = null) {
    if (classe === 'Dragon') return 999;
    if (classe === 'PhenixJ') return 998;
    if (classe === 'PhenixV') return 997;
    const poidsCouleur = { 'Vert': 0.1, 'Jaune': 0.2, 'Rouge': 0.3, 'Special': 0.4 };
    return rang + (poidsCouleur[couleur] || 0);
}

function analyserCombinaison(cartesJouees) {
    let nb = cartesJouees.length;
    if (nb === 0) return null;

    let combo = { nom: "", format: 0, puissance: 0, isGang: false };
    let rangBase = cartesJouees[0].rang;
    let estIdentique = cartesJouees.every(c => c.rang === rangBase);

    if (estIdentique && nb >= 4) {
        combo.format = nb;
        combo.puissance = (nb * 100) + rangBase; 
        combo.nom = "🔥 GANG OF " + nb + " 🔥";
        combo.isGang = true;
        return combo;
    }

    if (estIdentique && nb < 4) {
        combo.format = nb;
        let cartePlusForte = cartesJouees[0];
        cartesJouees.forEach(c => {
            if(getPuissanceCarte(c.rang, c.couleur, c.classe) > getPuissanceCarte(cartePlusForte.rang, cartePlusForte.couleur, cartePlusForte.classe)) cartePlusForte = c;
        });
        combo.puissance = getPuissanceCarte(cartePlusForte.rang, cartePlusForte.couleur, cartePlusForte.classe);
        combo.nom = (nb === 1) ? "Carte Seule" : (nb === 2) ? "Paire" : "Brelan";
        return combo;
    }

    if (nb === 5) {
        // CORRECTION DU BUG FULL : On interdit UNIQUEMENT Dragon et Phénix, pas le "1" Multi
        let contientInterdit = cartesJouees.some(c => c.classe === 'Dragon' || c.classe === 'PhenixV' || c.classe === 'PhenixJ');
        if (contientInterdit) return null;

        let cartesTriees = [...cartesJouees].sort((a,b) => a.rang - b.rang);
        let isSuite = true;
        for(let i = 1; i < 5; i++) { if (cartesTriees[i].rang !== cartesTriees[i-1].rang + 1) isSuite = false; }
        
        // CORRECTION COULEUR : Le "1" Multi prend la couleur des autres
        let couleurBase = cartesJouees.find(c => c.couleur !== 'Special')?.couleur;
        let isCouleur = couleurBase ? cartesJouees.every(c => c.couleur === couleurBase || c.couleur === 'Special') : false;

        let isFull = (cartesTriees[0].rang === cartesTriees[2].rang && cartesTriees[3].rang === cartesTriees[4].rang) ||
                     (cartesTriees[0].rang === cartesTriees[1].rang && cartesTriees[2].rang === cartesTriees[4].rang);

        combo.format = 5;
        let carteMax = cartesTriees[4];

        if (isSuite && isCouleur) {
            combo.nom = "🌟 QUINTE FLUSH 🌟";
            combo.puissance = 300 + getPuissanceCarte(carteMax.rang, carteMax.couleur, carteMax.classe);
            return combo;
        }
        if (isFull) {
            combo.nom = "Full";
            // La puissance du full dépend toujours du brelan (carte index 2 après tri)
            combo.puissance = 200 + cartesTriees[2].rang;
            return combo;
        }
        if (isCouleur) {
            combo.nom = "Couleur";
            combo.puissance = 100 + getPuissanceCarte(carteMax.rang, carteMax.couleur, carteMax.classe);
            return combo;
        }
        if (isSuite) {
            combo.nom = "Suite";
            combo.puissance = getPuissanceCarte(carteMax.rang, carteMax.couleur, carteMax.classe);
            return combo;
        }
    }
    return null;
}

function attribuerNomsIA() {
    let countIA = 1;
    for(let i=0; i<4; i++) { if(typesJoueurs[i] === 'ia') nomsJoueurs[i] = `IA ${countIA++}`; }
}

function demarrerNouvelleManche() {
    let paquet = genererPaquet();
    for (let i = paquet.length - 1; i > 0; i--) {
        let j = Math.floor(Math.random() * (i + 1));
        let temp = paquet[i]; paquet[i] = paquet[j]; paquet[j] = temp;
    }
    for (let i = 0; i < 4; i++) { mains[i] = trierCartes(paquet.slice(i * 16, (i + 1) * 16)); }

    etatTable = null;
    nbPassesCons = 0;
    maitreDuPli = 0;

    if (dernierGagnant !== null && dernierPerdant !== null) {
        let mainPerdant = mains[dernierPerdant];
        let bestIndex = 0; let bestPower = 0;
        mainPerdant.forEach((c, i) => {
            let p = getPuissanceCarte(c.rang, c.couleur, c.classe);
            if(p > bestPower) { bestPower = p; bestIndex = i; }
        });
        
        let carteDonnee = mainPerdant.splice(bestIndex, 1)[0];
        mains[dernierGagnant].push(carteDonnee);
        mains[dernierGagnant] = trierCartes(mains[dernierGagnant]);

        if (typesJoueurs[dernierGagnant] === 'ia') {
            let pireCarte = mains[dernierGagnant].splice(0, 1)[0];
            mains[dernierPerdant].push(pireCarte);
            mains[dernierPerdant] = trierCartes(mains[dernierPerdant]);
            lancerPartie();
        } else {
            phaseEchange = true;
            synchroniserToutLeMonde();
            io.to(connexions[dernierGagnant]).emit('demandeEchange', carteDonnee);
        }
    } else {
        lancerPartie();
    }
}

function lancerPartie() {
    phaseEchange = false;
    joueurActif = dernierGagnant !== null ? dernierGagnant : 0;
    partieEnCours = true;
    synchroniserToutLeMonde();
    verifierTourIA();
}

function synchroniserToutLeMonde() {
    for (let i = 0; i < 4; i++) {
        if (typesJoueurs[i] === 'humain' && connexions[i]) {
            io.to(connexions[i]).emit('etatPartie', {
                votreIndex: i, maMain: mains[i], joueurActif: joueurActif,
                etatTable: etatTable, taillesMains: mains.map(m => m.length),
                scoresGlobaux: scoresGlobaux, nomsJoueurs: nomsJoueurs,
                phaseEchange: phaseEchange, dernierGagnant: dernierGagnant
            });
        }
    }
}

function verifierTourIA() {
    if (!partieEnCours || phaseEchange) return;
    if (typesJoueurs[joueurActif] === 'ia') setTimeout(faireJouerIA, 1500);
}

function faireJouerIA() {
    let mainIA = mains[joueurActif];
    let aJoue = false;
    let comboA_Jouer = [];
    let groupes = {};
    mainIA.forEach(c => {
        if(!groupes[c.rang]) groupes[c.rang] = [];
        groupes[c.rang].push(c);
    });

    if (etatTable === null) {
        let paire = Object.values(groupes).find(g => g.length === 2);
        if (paire) comboA_Jouer = paire;
        else comboA_Jouer = [mainIA[0]]; 
    } else {
        let fDemande = etatTable.format;
        let pDemande = etatTable.puissance;

        if (fDemande === 1) {
            for (let i = 0; i < mainIA.length; i++) {
                if (getPuissanceCarte(mainIA[i].rang, mainIA[i].couleur, mainIA[i].classe) > pDemande) {
                    comboA_Jouer = [mainIA[i]]; break;
                }
            }
        } else if (fDemande === 2 || fDemande === 3) {
            let formatsValides = Object.values(groupes).filter(g => g.length >= fDemande);
            for (let g of formatsValides) {
                let comboTest = g.slice(0, fDemande);
                let info = analyserCombinaison(comboTest);
                if (info && info.puissance > pDemande) {
                    comboA_Jouer = comboTest; break;
                }
            }
        }
    }

    if (comboA_Jouer.length > 0) {
        let info = analyserCombinaison(comboA_Jouer);
        if (info) {
            comboA_Jouer.forEach(c => {
                let idx = mainIA.findIndex(m => m.id === c.id);
                if (idx > -1) mainIA.splice(idx, 1);
            });
            etatTable = info; etatTable.cartes = comboA_Jouer; etatTable.nomProprio = nomsJoueurs[joueurActif];
            nbPassesCons = 0; maitreDuPli = joueurActif; aJoue = true;
        }
    }

    if (!aJoue) nbPassesCons++;

    if (mainIA.length === 0) { partieTerminee(joueurActif); return; }
    passerAuJoueurSuivant();
}

function passerAuJoueurSuivant() {
    if (nbPassesCons >= 3) { etatTable = null; nbPassesCons = 0; joueurActif = maitreDuPli; }
    else { joueurActif = (joueurActif + 1) % 4; }
    synchroniserToutLeMonde(); verifierTourIA();
}

function partieTerminee(gagnant) {
    partieEnCours = false;
    dernierGagnant = gagnant;
    
    let maxCartes = -1; dernierPerdant = 0;
    mains.forEach((m, i) => { if(m.length > maxCartes) { maxCartes = m.length; dernierPerdant = i; } });

    let penalites = mains.map(m => {
        let n = m.length;
        if (n <= 7) return n; if (n <= 9) return n * 2; if (n <= 15) return n * 3; return n * 4;
    });

    for(let i=0; i<4; i++) scoresGlobaux[i] += penalites[i];

    io.emit('finManche', { gagnant: gagnant, nomGagnant: nomsJoueurs[gagnant], scoresGlobaux: scoresGlobaux });
}

io.on('connection', (socket) => {
    if (connexions.length === 0) socket.emit('statutHote', true);
    else socket.emit('statutHote', false);

    socket.on('configurerPartie', (data) => {
        config.nbHumains = parseInt(data.nbHumains);
        connexions = [socket.id]; typesJoueurs = ['humain', 'ia', 'ia', 'ia'];
        nomsJoueurs = ['IA 1', 'IA 2', 'IA 3', 'IA 4'];
        nomsJoueurs[0] = data.pseudo || "Joueur 1";
        
        for(let i=1; i < config.nbHumains; i++) { typesJoueurs[i] = 'humain'; nomsJoueurs[i] = 'En attente...'; }

        if (connexions.length === config.nbHumains) { attribuerNomsIA(); demarrerNouvelleManche(); }
        else { io.emit('attenteJoueurs', { connectes: connexions.length, requis: config.nbHumains }); }
    });

    socket.on('rejoindrePartie', (data) => {
        if (connexions.length < config.nbHumains && !connexions.includes(socket.id)) {
            let index = connexions.length; connexions.push(socket.id);
            nomsJoueurs[index] = data.pseudo || `Joueur ${index + 1}`;
            if (connexions.length === config.nbHumains) { attribuerNomsIA(); demarrerNouvelleManche(); }
            else { io.emit('attenteJoueurs', { connectes: connexions.length, requis: config.nbHumains }); }
        }
    });

    socket.on('actionDonnerCarte', (carteId) => {
        if (!phaseEchange) return;
        let monIndex = connexions.indexOf(socket.id);
        if (monIndex !== dernierGagnant) return;

        let idx = mains[monIndex].findIndex(c => c.id === carteId);
        if (idx > -1) {
            let carteDonnee = mains[monIndex].splice(idx, 1)[0];
            mains[dernierPerdant].push(carteDonnee);
            mains[dernierPerdant] = trierCartes(mains[dernierPerdant]);
            lancerPartie();
        }
    });

    socket.on('actionJouer', (cartesSelectionnees) => {
        if (phaseEchange) return;
        let monIndex = connexions.indexOf(socket.id);
        if (monIndex !== joueurActif) return;

        let info = analyserCombinaison(cartesSelectionnees);
        if (!info) { socket.emit('erreur', 'Combinaison invalide !'); return; }

        if (etatTable !== null) {
            if (info.isGang) { if (etatTable.isGang && info.puissance <= etatTable.puissance) { socket.emit('erreur', 'Ton Gang est trop faible !'); return; } } 
            else {
                if (etatTable.isGang) { socket.emit('erreur', 'Il te faut un Gang pour couper !'); return; }
                if (info.format !== etatTable.format) { socket.emit('erreur', 'Format incorrect.'); return; }
                if (info.puissance <= etatTable.puissance) { socket.emit('erreur', 'Combinaison trop faible.'); return; }
            }
        }

        cartesSelectionnees.forEach(c => {
            let idx = mains[monIndex].findIndex(m => m.id === c.id);
            if (idx > -1) mains[monIndex].splice(idx, 1);
        });

        etatTable = info; etatTable.cartes = cartesSelectionnees; etatTable.nomProprio = nomsJoueurs[monIndex];
        nbPassesCons = 0; maitreDuPli = monIndex;

        if (mains[monIndex].length === 0) { partieTerminee(monIndex); return; }
        passerAuJoueurSuivant();
    });

    socket.on('actionPasser', () => {
        if (phaseEchange) return;
        let monIndex = connexions.indexOf(socket.id);
        if (monIndex !== joueurActif) return;
        if (etatTable === null) { socket.emit('erreur', 'Tu dois ouvrir le pli !'); return; }

        nbPassesCons++; passerAuJoueurSuivant();
    });

    socket.on('demandeNouvelleManche', () => { demarrerNouvelleManche(); });
});

http.listen(3000, () => { console.log('Serveur en ligne'); });
