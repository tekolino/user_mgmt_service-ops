==================================================
RUNBOOK: KUBERNETES-CLUSTER NEU AUFBAUEN + VOLLSTÄNDIG TESTEN
==================================================

ZWECK DIESES DOKUMENTS: Dieses Runbook wurde bereits ZWEIMAL komplett
erfolgreich durchgespielt (Cluster gelöscht -> neu aufgebaut -> alle
Kriterien verifiziert). Alle vier ursprünglich unbekannten Fehler sind
bereits dauerhaft im Ops-Repo behoben. Bei Ausführung dieses Runbooks
sollten KEINE der unten beschriebenen Probleme mehr auftreten -- sie
sind nur zur Information dokumentiert, falls doch etwas abweicht.

KONTEXT / PROJEKT:
- Spring Boot Backend + Next.js Frontend + PostgreSQL
- Kubernetes auf DigitalOcean (DOKS), Helm, ArgoCD (GitOps)
- Core-Repo (Code + Pipeline): https://github.com/thinu-teko/user_mgmt_service
- Ops-Repo (Helm Chart + ArgoCD Manifeste): https://github.com/tekolino/user_mgmt_service-ops
- Drei Umgebungen im selben Cluster: default (deaktiviert, ignorieren),
  staging, production

VORAUSSETZUNG: kubectl, doctl, helm lokal installiert. Mit
DigitalOcean verbunden via "doctl auth init". Ops-Repo lokal geklont.

REALISTISCHE GESAMTDAUER: ca. 20-30 Minuten (grösstenteils reine
Wartezeit auf Provisionierung, nicht auf Fehlersuche).

==================================================
TEIL 1: CLUSTER NEU AUFBAUEN
==================================================

--- Schritt 1: Cluster erstellen ---

Über die DigitalOcean-Weboberfläche (https://cloud.digitalocean.com/kubernetes/clusters):
Create Cluster -> Region: FRA1 -> Name: vsc-kubernetes -> Node Pool: 2 Nodes.
Warten bis Status "Running" (ca. 3-5 Min).

--- Schritt 2: Verbindung herstellen ---

  doctl kubernetes cluster kubeconfig save vsc-kubernetes
  kubectl get nodes

ERWARTUNG: 2 Nodes, Status Ready.

--- Schritt 3: Helm-Repos hinzufügen (einmalig pro Cluster) ---

  helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
  helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
  helm repo add argo https://argoproj.github.io/argo-helm
  helm repo update

--- Schritt 4: ingress-nginx installieren (via Helm) ---

  helm install ingress-nginx ingress-nginx/ingress-nginx --namespace ingress-nginx --create-namespace --set controller.config.use-proxy-protocol=false
  kubectl get pods -n ingress-nginx -w

(Strg+C sobald ingress-nginx-controller-... 1/1 Running zeigt)

  kubectl get service -n ingress-nginx

Die dort angezeigte EXTERNAL-IP beim Service "ingress-nginx-controller"
notieren (ändert sich bei jedem Rebuild, wird für den späteren
Browsertest gebraucht). Kann kurz "<pending>" zeigen, dann 1-2 Min
warten.

BESTÄTIGT (getestet am 05.09.2026): Der Service heisst weiterhin
"ingress-nginx-controller" -- identisch zum Namen bei der älteren
Installation via rohem Community-Manifest. Alle nachfolgenden Befehle
in diesem Runbook funktionieren dadurch UNVERÄNDERT, unabhängig davon,
ob Helm oder das rohe Manifest genutzt wurde.

Der --set controller.config.use-proxy-protocol=false Parameter ersetzt
den früher nötigen separaten "kubectl patch configmap"-Befehl -- ein
Schritt gespart. (Hintergrund: Nur das DO-spezifische Community-
Manifest aktiviert use-proxy-protocol standardmässig; der generische
Helm-Chart-Default ist bereits "false", das explizite --set dient nur
zur Absicherung.)

--- Schritt 5: Metrics Server installieren (via Helm) ---

  helm install metrics-server metrics-server/metrics-server -n kube-system
  kubectl get pods -n kube-system | Select-String "metrics"
  kubectl top nodes

ERWARTUNG: kubectl top nodes zeigt eine Tabelle mit CPU/Memory-Werten
(keine Fehlermeldung). Falls ein TLS-Zertifikatsfehler auftritt (kam
bei allen bisherigen Durchläufen NICHT vor):

  kubectl patch deployment metrics-server -n kube-system --type=json -p='[{\"op\":\"add\",\"path\":\"/spec/template/spec/containers/0/args/-\",\"value\":\"--kubelet-insecure-tls\"}]'

--- Schritt 6: ArgoCD installieren (via Helm) ---

  kubectl create namespace argocd
  helm install argocd argo/argo-cd -n argocd
  kubectl get pods -n argocd -w

(Strg+C sobald alle Pods Running -- via Helm sind es andere/mehr
Einzel-Pods als bei der rohen Manifest-Installation, u.a. ein
zusätzlicher, kurzlebiger "argocd-redis-secret-init"-Job mit Status
Completed, das ist normal)

BESTÄTIGT (getestet am 05.09.2026): Die Objektnamen argocd-server
(Service) und argocd-initial-admin-secret (Secret) sind identisch zur
rohen Manifest-Installation. Kein Anpassungsbedarf bei den folgenden
Schritten.

VORTEIL gegenüber der rohen Manifest-Installation: Kein
"--server-side --force-conflicts"-Flag mehr nötig -- der zuvor
auftretende "Too long"-Fehler bei der applicationsets-CRD-Annotation
trat mit der Helm-Installation nicht auf (Helm verwaltet CRDs anders
als kubectl client-side apply).

Optional, Admin-Passwort fürs Dashboard holen:

  $encoded = kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}"
  [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encoded))

Dashboard-Zugriff (optional, nicht für den Funktionstest nötig):

  kubectl port-forward svc/argocd-server -n argocd 8888:443

(in einem SEPARATEN Terminal laufen lassen, dann https://localhost:8888
im Browser öffnen, Zertifikatswarnung bestätigen, Login mit admin +
obigem Passwort)

--- Schritt 6: Ops-Repo aktuell holen und Application-Manifeste anwenden ---

  cd <lokaler-pfad>\user_mgmt_service-ops
  git pull origin main
  kubectl apply -f .\argocd\

Das wendet automatisch alle drei Manifeste an (application.yaml,
application-staging.yaml, application-prod.yaml).

--- Schritt 7: Secrets in allen drei Namespaces neu anlegen ---

app-secret ist bewusst NICHT Teil des Helm Charts (Sicherheitsgrund --
Secrets landen nie in Git). Muss nach jedem Cluster-Neuaufbau manuell
erstellt werden. Da die Datenbank ohnehin leer ist (neues Volume),
können FRISCHE, zufällige Werte generiert werden:

  $dbPassword = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})
  $jwtSecret = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

  kubectl create secret generic app-secret --from-literal=SPRING_DATASOURCE_PASSWORD=$dbPassword --from-literal=JWT_SECRET=$jwtSecret -n default
  kubectl create secret generic app-secret --from-literal=SPRING_DATASOURCE_PASSWORD=$dbPassword --from-literal=JWT_SECRET=$jwtSecret -n staging
  kubectl create secret generic app-secret --from-literal=SPRING_DATASOURCE_PASSWORD=$dbPassword --from-literal=JWT_SECRET=$jwtSecret -n production

--- Schritt 8: Warten und Grundstatus prüfen ---

1-3 Minuten warten (Postgres-Init + Backend startupProbe bis zu 3 Min
Anlaufzeit), dann:

  kubectl get applications -n argocd

ERWARTUNG: Alle drei (user-mgmt-service, user-mgmt-service-staging,
user-mgmt-service-production) zeigen "Synced" / "Healthy".
user-mgmt-service (default-Namespace) kann dauerhaft "OutOfSync"
zeigen -- das ist beabsichtigt (bewusst auf 0 Replicas deaktiviert, um
Cluster-Ressourcen für staging/production freizuhalten), kein Fehler.

Falls staging/production NICHT synced sind, Sync erzwingen:

  kubectl annotate application user-mgmt-service-staging -n argocd argocd.argoproj.io/refresh=hard --overwrite
  kubectl annotate application user-mgmt-service-production -n argocd argocd.argoproj.io/refresh=hard --overwrite

==================================================
TEIL 2: VOLLSTÄNDIGER KRITERIEN-CHECK (AUFGABE 3-6)
==================================================

--- Aufgabe 3 (ArgoCD/GitOps) ---

  kubectl get applications -n argocd

ERWARTUNG: staging + production Synced/Healthy (siehe Schritt 8 oben).

--- Aufgabe 4 (Pipeline: Image-Versionierung) ---

  kubectl get deployment backend -n default -o jsonpath='{.spec.template.spec.containers[0].image}'

ERWARTUNG: Tag ist ein voller Git-Commit-SHA (z.B.
ghcr.io/thinu-teko/backend:ccd3ea06ae950413a50390484bf267c1ece6c6f3),
NICHT "latest".

--- Aufgabe 5 (Namespaces: Quotas, NetworkPolicies, Secrets) ---

  kubectl get resourcequota -n staging
  kubectl get resourcequota -n production
  kubectl get networkpolicy -n staging
  kubectl get networkpolicy -n production
  kubectl get secret app-secret -n staging
  kubectl get secret app-secret -n production

ERWARTUNG: Jeweils eine ResourceQuota, eine NetworkPolicy und ein
Secret "app-secret" (TYPE Opaque, DATA 2) pro Namespace.

--- Aufgabe 6 (Scaling: HPA, PDB, Strategien) ---

  kubectl get hpa -n staging
  kubectl get hpa -n production
  kubectl get pdb -n staging
  kubectl get pdb -n production
  kubectl get deployment backend -n staging -o jsonpath='{.spec.strategy.type}'
  kubectl get deployment postgres -n staging -o jsonpath='{.spec.strategy.type}'

ERWARTUNG:
- HPA: MINPODS 1, MAXPODS 2, REPLICAS 1 (solange keine Last anliegt)
- PDB: MIN AVAILABLE 1
- Backend-Strategy: RollingUpdate
- Postgres-Strategy: Recreate (bewusst, wegen ReadWriteOnce-PVC --
  zwei gleichzeitige Postgres-Pods würden Multi-Attach-Error
  verursachen)

==================================================
TEIL 3: LIVE-BEWEISE (nicht nur Konfiguration, sondern Funktion)
==================================================

--- 3a: HPA-Lasttest (beweist: Backend skaliert unter Last 1 -> 2) ---

Ein wiederverwendbarer Last-Generator-Pod liegt bereits im Ops-Repo
unter testing/load-generator.yaml (BEWUSST ausserhalb von chart/,
damit ArgoCD ihn NICHT automatisch mitdeployed -- er läuft in einer
Endlosschleife und würde sonst dauerhaft unnötig Last erzeugen).

  cd <lokaler-pfad>\user_mgmt_service-ops
  git pull origin main
  kubectl apply -f testing/load-generator.yaml

In einem ZWEITEN Terminal live beobachten:

  kubectl get hpa backend-hpa -n staging --watch

ERWARTUNG (nach 1-3 Minuten): TARGETS steigt weit über 70% (z.B.
900%+, bezogen auf die knapp bemessenen requests.cpu: 50m -- kein
Grund zur Sorge), danach REPLICAS springt von 1 auf 2.

Danach aufräumen (WICHTIG, nicht vergessen -- der Pod läuft sonst
dauerhaft weiter):

  kubectl delete -f testing/load-generator.yaml

Nach dem Löschen skaliert der HPA nach ca. 5 Minuten Cooldown
automatisch wieder auf 1 zurück (Standard-Verhalten gegen
"Flapping", kein Fehler).

--- 3b: Readiness-Test (beweist: nur "ready" Pods bekommen Traffic) ---

Aktuellen Pod-Namen ermitteln:

  kubectl get pods -n staging -o wide

Einen "ready" Backend-Pod gezielt löschen (Namen aus obiger Liste
einsetzen):

  kubectl delete pod <backend-pod-name> -n staging

SOFORT danach:

  kubectl get endpoints backend-service -n staging

ERWARTUNG: Endpoint-Liste ist kurzzeitig LEER oder zeigt nur den
verbleibenden Pod (falls mehrere liefen). Der von Kubernetes
automatisch neu erstellte Ersatz-Pod erscheint dort NICHT, solange er
READY 0/1 zeigt:

  kubectl get pods -n staging

Nach ca. 2 Minuten (startupProbe erlaubt bis zu 3 Min Anlaufzeit für
Spring Boot) erneut prüfen:

  kubectl get endpoints backend-service -n staging
  kubectl get pods -n staging

ERWARTUNG: Neuer Pod zeigt READY 1/1 und taucht automatisch (ohne
manuellen Eingriff) wieder in der Endpoint-Liste auf.

==================================================
TEIL 4: FUNKTIONSTEST ÜBER DIE ÖFFENTLICHE WEBOBERFLÄCHE
==================================================

  kubectl get service ingress-nginx-controller -n ingress-nginx

Die dort angezeigte EXTERNAL-IP im Browser öffnen (http://<IP>).
Registrierung + Login testen.

ERWARTUNG: Login-Seite lädt, Registrierung + Login funktionieren ohne
Fehler und ohne spürbare Verzögerung.

Falls Login/Registrierung mit "500 Internal Server Error" fehlschlägt
(sollte NICHT mehr auftreten, da bereits gefixt), zur Diagnose:

  kubectl exec deployment/frontend -n default -- printenv | Select-String "API"

Muss INTERNAL_API_URL=http://backend-service:8080 zeigen. Falls leer,
chart/templates/frontend-deployment.yaml im Ops-Repo prüfen -- dort
muss ein env-Block mit dieser Variable vorhanden sein.

Falls "504 Gateway Time-out" auftritt (sollte NICHT mehr auftreten):

  kubectl run netztest --image=curlimages/curl -n ingress-nginx --restart=Never -it --rm -- curl -v --max-time 5 http://frontend-service.default.svc.cluster.local

Falls das timeoutet, chart/templates/networkpolicy.yaml prüfen -- sie
muss neben dem podSelector-Eintrag einen zweiten ingress-Block mit
namespaceSelector.matchLabels["kubernetes.io/metadata.name"]:
"ingress-nginx" enthalten.

==================================================
TIPP: PowerShell-Escaping-Falle bei curl-Tests INNERHALB von Pods
==================================================

Befehle wie "kubectl exec ... -- sh -c 'curl ... -d {\"key\":\"value\"}'"
scheitern in PowerShell fast immer an mehrfach verschachteltem
Anführungszeichen-Escaping. ZUVERLÄSSIGER: Einen simplen Test-Pod mit
"sleep 3600" als Command starten, per "kubectl exec -it <pod> -- sh"
INTERAKTIV reingehen, und curl-Befehle direkt in der Linux-Shell
eintippen (kein PowerShell-Escaping mehr nötig):

  @'
  apiVersion: v1
  kind: Pod
  metadata:
    name: netztest
    namespace: default
  spec:
    restartPolicy: Never
    containers:
      - name: netztest
        image: curlimages/curl
        command: ["sleep", "3600"]
        resources:
          requests: { cpu: 50m, memory: 32Mi }
          limits: { cpu: 200m, memory: 64Mi }
  '@ | Set-Content -Path .\netztest.yaml -Encoding utf8

  kubectl apply -f .\netztest.yaml
  kubectl exec -it netztest -n default -- sh

  # Innerhalb der Shell, direkt eintippen:
  curl -X POST http://backend-service:8080/users/register -H "Content-Type: application/json" -d '{"firstName":"Test","lastName":"User","email":"test@test.com","password":"Test1234!"}'
  curl -i -X POST http://backend-service:8080/users/login -H "Content-Type: application/json" -d '{"email":"test@test.com","password":"Test1234!"}'
  exit

  kubectl delete -f .\netztest.yaml
  Remove-Item .\netztest.yaml

==================================================
WICHTIGE SICHERHEITSHINWEISE
==================================================

1. app-secret existiert nur direkt im Cluster, nie im Git-Repo. Bei
   jedem Rebuild werden neue, zufällige Werte generiert -- alte Werte
   müssen nicht gesichert werden.
2. OPS_REPO_TOKEN liegt als GitHub Secret im Core-Repo, Klartext nie
   im Chat/Code preisgeben.
3. ArgoCD Admin-Passwort selbst frisch aus dem Cluster holen, nicht
   herumreichen.
4. Keine Secrets/Tokens in Chats mit KI-Tools einfügen.

==================================================
KOSTEN-HINWEIS BEIM SPÄTEREN LÖSCHEN
==================================================

Beim Destroy des Clusters über die DigitalOcean-Oberfläche IMMER
"Destroy All" bei Load Balancers UND Volumes mit anhaken, sonst laufen
diese als separate, weiterhin kostenpflichtige Ressourcen weiter.
