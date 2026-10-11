# Stock pellets — mise en ligne (5 minutes)

Application web installable (PWA). Les données restent **uniquement sur ton téléphone** ; le site hébergé ne contient que le code.

## Publier sur GitHub Pages
1. Crée un dépôt GitHub (ex. `pellets`), public.
2. Envoie-y **tous les fichiers de ce dossier** (`index.html`, `app.js`, `style.css`, `sw.js`, `manifest.json`, dossier `icons/`) à la racine du dépôt.
3. Dépôt → **Settings → Pages** → Source : *Deploy from a branch* → branche `main`, dossier `/ (root)` → Save.
4. Après ~1 minute, l'adresse est `https://TON-PSEUDO.github.io/pellets/`.

## Installer sur Android
1. Ouvre l'adresse dans **Chrome** sur ton téléphone.
2. Menu ⋮ → **Installer l'application** (ou « Ajouter à l'écran d'accueil »).
3. Au premier lancement : stock (85), date d'ouverture du sac en cours, prix de la palette.

## Important
- Utilise **toujours la même adresse** : les données sont liées à celle-ci.
- Fais une sauvegarde (Réglages → Sauvegarde complète JSON) de temps en temps ; elle permet de tout restaurer si tu changes de téléphone.
- Pour mettre à jour l'appli plus tard : remplace les fichiers dans le dépôt (change `CACHE = 'pellets-v1'` en `v2` dans `sw.js`).
