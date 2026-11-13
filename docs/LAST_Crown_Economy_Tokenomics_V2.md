# LAST — Crown Economy
## Proposition de tokenomics V2 | NEAR Hackathon 2026

**Statut : PROPOSITION À AUDITER — NON IMPLÉMENTÉE PAR DÉFAUT**  
**Produit :** LAST — Last Buyer Wins  
**Objectif :** renforcer l'identité du memecoin-jeu et donner de la continuité économique aux manches, sans token utilitaire artificiel.  
**Périmètre :** NEAR Testnet, équipe de 2 développeurs, priorité au parcours `buy → settle_round → claim_reward`.

> **Règle de gouvernance technique :** ce document ne remplace pas automatiquement `docs/SPEC_V2.md`, `docs/CONTRACT_API.md` ni les paramètres du contrat existant. Builder A doit d'abord auditer les impacts sur Gate 2, les tests et les invariants financiers. Aucun redéploiement ni modification des paramètres d'un contrat déjà déployé sans décision explicite de l'équipe.

---

## 1. Concept produit : « Steal the Crown »

**LAST est un memecoin ludique, pas un jeton utilitaire.**

- Acheter LAST peut permettre de voler la *couronne* au dernier acheteur éligible.
- Tout achat **éligible**, et uniquement lui, réinitialise le compte à rebours de la manche.
- Une vente ne réinitialise jamais le timer.
- Si aucun nouvel achat éligible n'arrive avant expiration, le dernier acheteur éligible gagne une cagnotte en NEAR.
- La manche est finalisée par un appel public `settle_round()` ; le contrat ne se déclenche pas seul à l'expiration.
- Le vainqueur peut demander sa récompense par `claim_reward()` ou la méthode convenue dans l'API du contrat.
- Une nouvelle manche peut démarrer selon une machine à états explicite, indépendamment du moment où un ancien gagnant réclame son gain.

Le token LAST n'a **pas besoin** de staking, d'adhésion premium, de gouvernance DAO ou d'abonnement pour justifier sa présence. Son identité repose sur la compétition, l'appartenance à la communauté, les records et les règnes.

**Phrase centrale :** *There can only be one LAST.*

**Référence conceptuelle :** les mécanismes « last buyer wins » existaient déjà, notamment FOMO3D. Ne pas revendiquer l'invention du jeu ni garantir l'absence de bots.

---

## 2. Diagnostic de la tokenomics actuelle

Paramètres transmis par l'équipe pour l'état de développement (à revérifier dans les contrats) :

| Paramètre | État annoncé |
|---|---:|
| Frais d'achat | 4 % du NEAR brut payé |
| Frais de vente | 2 % de la valeur brute de sortie NEAR, à confirmer dans le code |
| Allocation de frais au jackpot | 70 % |
| Allocation de frais à la manche suivante | 10 % |
| Allocation de frais à la trésorerie | 15 % |
| Allocation de frais à la plateforme | 5 % |
| Timer de démonstration | 120 secondes |
| Achat minimal éligible de référence | 0,03 NEAR |

**Faiblesses :**

1. Le joueur qui perd la couronne ne conserve qu'un memecoin spéculatif ; cela n'implique pas que le jeu doive créer un rendement pour les holders.
2. L'extraction combinée de **20 % des frais** vers trésorerie et plateforme est difficile à justifier au stade MVP si la trésorerie n'a pas de politique vérifiable.
3. Les jackpots de départ peuvent être trop faibles si chaque manche repart de zéro.
4. Une réserve reportée sans conditions pourrait être captée à coût réduit par un seul bot.
5. Les bots ont un avantage de latence et de disponibilité. Un minimum d'achat n'est pas une mesure anti-bot suffisante.
6. Aucun réagencement des frais ne crée des revenus externes ou ne garantit la longévité du jeu.

---

## 3. Trois modèles économiques comparés

La répartition porte **uniquement sur les frais du protocole**, pas sur la totalité du montant d'achat ou de vente. Les frais réseau NEAR sont distincts.

| Modèle | Jackpot courant | Report vers futures manches | Trésorerie | Plateforme | Évaluation |
|---|---:|---:|---:|---:|---|
| A — Actuel | 70 % | 10 % | 15 % | 5 % | Référence ; une trésorerie peu justifiée |
| B — Jackpot maximal | 95 % | 0 % | 0 % | 5 % | Jackpot immédiat plus gros, mais redémarrage à zéro |
| **C — Crown Economy (proposition)** | **85 %** | **10 %** | **0 %** | **5 %** | Préserve la continuité tout en réorientant les frais vers le jeu |

**Recommandation de cadrage : C**, à condition que le mécanisme de report soit validé par simulations et tests. Ne pas modifier les taux d'achat/vente pour l'instant.

### Exemple : achat de 1 NEAR

Hypothèses : frais d'achat de 4 % et absence de frais additionnels prélevés par le protocole.

| Flux | Montant |
|---|---:|
| Réserve économique du marché / montant net de trading | 0,9600 NEAR |
| Frais totaux prélevés | 0,0400 NEAR |
| dont jackpot courant : 85 % des frais | **0,0340 NEAR** |
| dont réserve de report : 10 % des frais | **0,0040 NEAR** |
| dont plateforme : 5 % des frais | **0,0020 NEAR** |
| **Total affecté** | **1,0000 NEAR** |

Exemple vente : si une sortie a une **valeur brute de 1 NEAR avant frais** et des frais de vente de 2 %, l'utilisateur reçoit un crédit net de 0,98 NEAR ; les 0,02 NEAR de frais sont répartis selon 85/10/5. Cette convention doit être confirmée par Builder A : le traitement exact des ventes dépend de la formule et du code existants.

### Précision essentielle sur les réserves

- La **réserve de marché** couvre les engagements économiques de rachat du token selon la courbe de prix : elle ne doit jamais servir au jackpot.
- Le **jackpot de manche** est un passif envers le gagnant, dès que celui-ci est confirmé.
- La **réserve de report** est une allocation séparée destinée à de futures manches, soumise à une politique de libération.
- Les **crédits NEAR retirables** appartiennent aux utilisateurs et restent des passifs séparés.
- La **part plateforme** ne peut être retirée que si le contrat reste solvable, en tenant compte du storage et des frais.

---

## 4. Crown Economy : réserve de report conditionnelle

### Pourquoi ne pas verser la totalité du report au prochain gagnant ?

Un joueur peut tenter de démarrer une manche presque seul, prendre la couronne avec un petit achat, attendre l'expiration et capter des fonds accumulés lors de manches précédentes. Une réserve entièrement transférée sans conditions encourage ce type de capture.

### Formule candidate, à tester

Soit :

- `F_r` = frais **du protocole réellement collectés pendant la manche r** et correctement attribués à cette manche ;
- `J_r = floor(0.85 × F_r)` = allocation au jackpot courant ;
- `N_r = floor(0.10 × F_r)` = nouvelle allocation à la réserve de report ;
- `P_r = F_r − J_r − N_r` = allocation plateforme, avec conservation exacte des arrondis ;
- `R_previous` = réserve reportée disponible **au début de la manche**, sans les nouvelles allocations `N_r` ;
- `U_r = min(R_previous, floor(0.15 × F_r))` = montant maximum libérable depuis l'ancienne réserve.

**Récompense maximale de la manche :**

`Prize_r = J_r + U_r`.

**Réserve reportée restante à la clôture :**

`R_next = R_previous − U_r + N_r`.

**Point important :** les 15 % représentent un **plafond de libération de l'ancienne réserve**, et NON un cinquième poste de frais. On ne crée aucun NEAR supplémentaire.

Pour la V2 proposée, l'ancienne réserve est figée au début de la manche pour éviter de financer le jackpot instantanément avec les apports de cette même manche. La comptabilité doit être fixée précisément par le contrat, pas reconstruite depuis le frontend.

### Exemples de versements (ancienne réserve = 0,4 NEAR)

Hypothèse pédagogique : tous les volumes sont des achats, avec 4 % de frais. Les arrondis ci-dessous sont illustratifs.

| Volume brut de la manche | Frais `F_r` | Jackpot courant `J_r` | Déblocage `U_r` | Gain `Prize_r` | Réserve suivante `R_next` |
|---:|---:|---:|---:|---:|---:|
| 0,10 NEAR | 0,0040 | 0,0034 | 0,0006 | **0,0040** | 0,3998 |
| 1 NEAR | 0,0400 | 0,0340 | 0,0060 | **0,0400** | 0,3980 |
| 5 NEAR | 0,2000 | 0,1700 | 0,0300 | **0,2000** | 0,3900 |
| 20 NEAR | 0,8000 | 0,6800 | 0,1200 | **0,8000** | 0,3600 |
| 100 NEAR | 4,0000 | 3,4000 | 0,4000 | **3,8000** | 0,4000 |

**Interprétation :** avec cette formule, une nouvelle manche faiblement active ne peut récupérer qu'une faible quantité de l'ancienne réserve. Cette propriété ne rend pas la mécanique « bot-proof » ; elle réduit seulement certains scénarios de capture de la cagnotte héritée.

### Limites du modèle proposé

- La réserve de report est surtout une **réallocation temporelle des frais**, pas une source de rendement.
- Si les volumes restent élevés et les manches sont nombreuses, la réserve peut se stabiliser ou fluctuer ; elle ne croît pas forcément.
- Si un bot peut générer artificiellement du volume par des allers-retours, il faut inclure frais, slippage, gas et évolution de la courbe de prix dans les simulations : le simple nombre d'achats ne mesure pas une participation organique.
- Les achats non éligibles et les ventes peuvent alimenter les frais selon le contrat ; ils ne doivent pas pour autant voler la couronne.
- Une manche sans acheteur éligible ne doit **jamais** créer un gagnant fictif ; les fonds restent correctement affectés à la réserve ou au cycle suivant selon une règle explicite.
- L'attribution des frais lors d'achats ou ventes après expiration mais avant `settle_round()` doit être précisément définie : une transaction ne doit pas gonfler rétroactivement une manche terminée.

### Détail d'implémentation critique

Ne pas confondre les pourcentages suivants :

- **85/10/5** = allocation initiale **des frais** ;
- **15 % de `F_r`** = plafond de libération de l'ancienne réserve **au règlement**, si elle existe.

Les transferts en NEAR étant asynchrones sur NEAR, `settle_round()` devrait réserver le gain comme créance puis `claim_reward()` ou `withdraw_near_credit()` effectuer le paiement avec état `IN_FLIGHT`, callback idempotent et restauration appropriée du crédit en cas d'échec.

---

## 5. Seuil d'achat éligible et bots

### Situation actuelle

Le seuil de référence annoncé est de **0,03 NEAR** pour devenir dernier acheteur. Il ne faut pas confondre :

- **Acheter LAST :** opération de marché, éventuellement sous le seuil ;
- **Devenir dernier acheteur :** droit déclenché seulement si les conditions d'éligibilité sont satisfaites.

### Hypothèse de seuil dynamique — NON VALIDÉE

Formule candidate étudiée précédemment :

`min_eligible_buy = max(0.10 NEAR, 0.20 × jackpot_courant)`.

**Ce seuil n'est pas une décision d'implémentation.** Builder A doit comparer le seuil fixe à ce scénario avant toute modification.

| Jackpot courant | Seuil hypothétique | Coût théorique d'un aller-retour au seul titre des frais* |
|---:|---:|---:|
| 0,1 NEAR | 0,10 NEAR | 0,00592 NEAR |
| 1 NEAR | 0,20 NEAR | 0,01184 NEAR |
| 5 NEAR | 1 NEAR | 0,05920 NEAR |
| 10 NEAR | 2 NEAR | 0,11840 NEAR |

\* Approximation : `1 − (1 − 0.04)(1 − 0.02) = 5.92 %`, hors slippage, mouvements de prix, gas et impact de marché ; pas une prévision de perte réelle.

**Objection centrale du conseil :** augmenter le seuil ne désavantage pas nécessairement un bot par rapport à un humain ; cela risque surtout d'exclure les petits joueurs.

Critères de validation :

1. Simulation des achats/reventes à différents niveaux de jackpot ;
2. Sensibilité au slippage et au comportement de la courbe de prix ;
3. Proportion des joueurs exclus par les seuils ;
4. Risques d'achats envoyés juste avant expiration ;
5. Paramètre view `get_min_eligible_buy()` (ou équivalent seulement après accord d'API) ;
6. Protection contre les changements de seuil entre affichage et inclusion de transaction, par exemple garde explicite dans la signature de la méthode si l'architecture le justifie ;
7. Absence d'affirmation « anti-bot » ou « fair for all » sans preuve.

**Recommandation de livraison :** préserver le seuil fixe et Gate 2 si le changement introduit un risque de régression.

---

## 6. Tokenomics : ce qu'on **n'ajoute pas** en V2

- **Pas de staking** à rendement promis ou artificiel.
- **Pas de dividendes passifs** pour les détenteurs de LAST.
- **Pas de DAO** ou gouvernance complexe.
- **Pas de mint inflationniste automatique** pour récompenser les prises de couronne.
- **Pas de buyback / burn** de dernière minute ; cela nécessite plus de code et ne garantit aucune hausse de prix.
- **Pas de système NFT obligatoire** ni de droits économiques masqués.
- **Pas d'utilité forcée** (accès premium, services, abonnements) pour justifier le memecoin.

L'attrait recherché est ludique et communautaire, pas celui d'un token productif.

---

## 7. Identité communautaire : Crown Economy sans token supplémentaire

### Principes

- Le leader porte publiquement la **couronne LAST** jusqu'à ce qu'un autre achat éligible la remplace ou que la manche expire.
- Les événements sont déterminés par l'état onchain : couronnement, fin de manche, gagnant, montant gagné.
- L'historique affiche les règnes, les records et les manches terminées.
- Un spectateur non connecté peut suivre le jeu ; aucune action quotidienne n'est nécessaire pour consulter les résultats.
- Les données hors chaîne (animations, avatars, surnoms) ne peuvent pas modifier le dernier acheteur ni les gains.

### MVP frontend

1. Grand timer et jackpot réellement lus depuis le contrat ;
2. « Current Crown Holder » ;
3. Prix d'entrée éligible et frais affichés avant signature ;
4. Historique des dernières prises de couronne et des manches, uniquement si le contrat fournit les données ou si un indexeur fiable les reconstruit ;
5. Statuts de transaction `PENDING / CONFIRMED / FAILED` ;
6. Bannière **NEAR TESTNET — TEST FUNDS ONLY**.

**Ne pas** inventer de leaderboard exhaustif si le contrat ne stocke pas les données nécessaires.

---

## 8. Invariants et sécurité non négociables

1. **Conservation des actifs :** à tout instant, les NEAR effectivement détenus, moins le storage immobilisé et les frais irréversibles, doivent couvrir l'ensemble des passifs exigibles (réserve de marché, jackpots, crédits de retrait, réserve de report et éventuelle part plateforme non retirée).
2. **Aucune double comptabilisation :** une unité de NEAR ne peut appartenir simultanément à deux catégories.
3. **Un seul gagnant par manche**, immuable après finalisation.
4. **Pas de réouverture rétroactive :** un achat arrivant après expiration ne remplace pas le gagnant historique, même si `settle_round()` n'a pas encore été appelé.
5. **Pas de double claim :** les paiements asynchrones doivent être idempotents.
6. **Pas de versement depuis la réserve de marché :** le jackpot n'utilise que ses fonds affectés.
7. **Pas de gagnant fictif** pour les manches sans achat éligible.
8. **Respect des unités :** yoctoNEAR en `u128` et formats JSON U128 / U64 compatibles NEAR ; pas de calcul financier en `f64`.
9. **Arrondis déterministes :** appliquer un ordre explicite, allouer les restes et prouver l'égalité des sommes.
10. **Administration limitée :** aucun admin ne doit pouvoir réécrire le vainqueur, confisquer la réserve de marché ou modifier les règles d'une manche en cours.
11. **Transparence :** distinguer les frais du protocole des frais réseau, et ne jamais annoncer une récompense avant confirmation onchain.
12. **Échecs réparables :** un transfert NEAR échoué ne doit pas effacer définitivement la créance du bénéficiaire.

---

## 9. Plan de tests recommandé

### Unitaires

- Répartition des frais achat / vente et arrondis extrêmes ;
- `85 % + 10 % + 5 % = 100 %` pour les montants atomiques ;
- Évolution `R_next = R_previous − U_r + N_r` ;
- Report nul, faible, important ;
- Manche avec 0 frais ;
- Manche avec uniquement achats non éligibles ;
- Manche avec ventes mais aucun leader ;
- Achats juste avant / exactement à / juste après le deadline ;
- Deux achats successifs dans le même bloc avec ordre d'exécution déterminé ;
- Settlement répété, claim répété et tentative de réclamer au nom d'autrui ;
- Callback NEAR échoué et nouvelle tentative ;
- Liquidité du marché suffisante après plusieurs cycles de ventes, jackpots et retraits ;
- Comparaison seuil fixe / seuil dynamique, sans modification du code du contrat par défaut.

### Scénarios économiques hors chaîne

- Joueur unique ;
- 2 joueurs qui se remplacent la couronne ;
- Bot qui pratique des allers-retours ;
- Plusieurs bots en concurrence au dernier moment ;
- Volume élevé avec slippage ;
- 10 à 100 manches à activité intermittente ;
- Sensibilité au nombre de joueurs humains, avec mesure de l'accès pour les petits budgets.

### Testnet (uniquement après autorisation de signature)

- Buy A → Buy B → timer expiré → settle → claim ;
- Vérification des montants en explorer ;
- Une seconde tentative de claim rejetée ;
- Vente sans reset du timer ;
- Nouvelle manche, vérification du report et des soldes.

---

## 10. Processus de décision pour Builder A et Builder B

### Gate 2 d'abord

Ne **pas** effectuer un changement économique majeur si `settle_round()`, `claim_reward()` et les tests d'invariants ne sont pas encore terminés.

### Audit d'impact avant implémentation

Builder A doit produire :

- Différences exactes entre la version Git du contrat et cette proposition ;
- Effet de la répartition 85/10/5 sur la comptabilité, les tests et le storage ;
- Validité du report conditionnel, avec simulation et tests d'abus ;
- Conséquence sur `docs/CONTRACT_API.md` et la compatibilité frontend ;
- Estimation du temps de développement et risques de régression ;
- Décision recommandée parmi **ADOPTER / DIFFÉRER / REJETER** chaque changement.

Builder B doit prévoir une interface affichant les chiffres réels du contrat, et **ne pas** coder la répartition comme constante 85/10/5 tant que Builder A ne l'a pas implémentée et exposée.

### Déploiement

- **NEAR Testnet uniquement** pour le hackathon ;
- Pas de fonds réels, pas de promesse de gains ou de rendement ;
- Pas de transaction signée, push ou déploiement automatique sans accord explicite du responsable du projet ;
- Vérification des règles actuelles du NEAR Hackathon avant soumission.

---

## 11. Conclusion du conseil simulé

**Décision pour le hackathon : continuer LAST ; privilégier un MVP vérifiable.**

**Décision de conception :** étudier **Crown Economy 85/10/5**, sa réserve reportée et l'identité « Steal the Crown », sans changer précipitamment les contrats déjà développés.

**Réserve critique :** la tokenomics proposée ne crée pas de revenus externes, ne rend pas les bots inoffensifs et ne garantit pas une demande durable. LAST doit être présenté comme un **memecoin-jeu**, et non comme un véhicule d'investissement.

**Condition d'abandon/pause :** si Gate 2 ne fonctionne pas, si les réserves ne sont pas prouvées solvables ou si le projet envisage un lancement à mises réelles sans analyse réglementaire, interrompre cette évolution et revenir au prototype testnet le plus sûr.

### Synthèse rapide

| Décision | Statut |
|---|---|
| Identité « Steal the Crown » | **À adopter côté UX** |
| Frais 4 % achat / 2 % vente | **Conserver** |
| Allocation 85 % jackpot / 10 % report / 5 % plateforme | **Proposition à auditer** |
| Libération du report plafonnée à 15 % des frais de la manche | **Proposition à simuler / tester** |
| Minimum dynamique d'achat éligible | **Expérience, non approuvée** |
| Burn / staking / dividendes | **Exclus du MVP** |
| Gate 2 et audit des invariants | **Priorité absolue** |

---

*Document de cadrage et de discussion interne — 12 novembre 2026. Ce document n'atteste pas que la V2 soit implémentée, auditée ou déployée.*
