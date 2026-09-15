==================================================
RUNBOOK v2: KOMPLETTER TERRAFORM-BASIERTER AUFBAU
==================================================

STATUS: Am 15.09.2026 vollständig von Grund auf getestet (Cluster +
Managed Database gelöscht und neu aufgebaut). Dieses Runbook ersetzt
alle früheren Versionen (insbesondere die reinen kubectl/doctl-basierten
Anleitungen ohne Terraform).

KONTEXT:
- Core-Repo (Code + Pipeline): https://github.com/thinu-teko/user_mgmt_service
- Ops-Repo (Helm Chart): https://github.com/tekolino/user_mgmt_service-ops
- Infra-Repo (Terraform): https://github.com/tekolino/user_mgmt_service-infra
- Drei Umgebungen: default (deaktiviert/veraltet, siehe unten),
  staging, production

REALISTISCHE GESAMTDAUER: ca. 30-40 Minuten (grösstenteils Wartezeit
auf Provisionierung: Cluster ~6 Min, Datenbank ~4 Min parallel, Pod-
Startzeiten).

VORAUSSETZUNG (einmalig pro Rechner):
- kubectl, doctl, helm, terraform, psql installiert und im PATH
  (Windows: nach winget-Installation IMMER komplettes Terminal-Fenster
  neu starten, PATH wird sonst nicht geladen)
- doctl auth init mit gültigem DigitalOcean API-Token
- terraform.tfvars lokal mit do_token befüllt (NIEMALS committen,
  liegt in .gitignore)

==================================================
TEIL 1: INFRASTRUKTUR MIT TERRAFORM AUFBAUEN
==================================================

--- Schritt 1: Repos aktuell holen ---

  cd <pfad>\user_mgmt_service-infra
  git pull origin main

--- Schritt 2: Cluster + Managed Database + GRANT-Jobs in einem Rutsch ---

  terraform plan

  ERWARTUNG: "7 to add" bei einem komplett frischen Aufbau, ODER
  "2 to add" falls Datenbank-Ressourcen aus einem vorherigen,
  teilweise fehlgeschlagenen apply schon im State stehen (siehe
  Troubleshooting unten). Prüfen, dass KEIN "Preparing import..."
  in der Ausgabe erscheint (Hinweis auf ein vergessenes import.tf,
  siehe Troubleshooting).

  terraform apply

  "yes" bestätigen. Dauert ca. 5-6 Minuten (Cluster und Datenbank
  werden parallel erstellt, Cluster braucht meist am längsten).

  Terraform erstellt automatisch:
  - digitalocean_kubernetes_cluster.vsc (2 Nodes, FRA1)
  - digitalocean_database_cluster.postgres (Managed PostgreSQL 16)
  - Zwei Datenbanken (staging, production)
  - Zwei DB-User (staging_user, production_user)
  - Eine Firewall-Regel (nur der eigene Cluster darf zugreifen)
  - ZWEI Kubernetes-Jobs, die automatisch GRANT ALL ON SCHEMA public
    für beide User ausführen (siehe LÜCKE #6 weiter unten -- das ist
    der entscheidende, in Terraform verankerte Fix)

--- Schritt 3: Verbindung zum Cluster herstellen ---

  doctl kubernetes cluster kubeconfig save vsc-kubernetes
  kubectl get nodes

  ERWARTUNG: 2 Nodes, Ready.

--- Troubleshooting: "422 setting a custom worker VPC subnet is not
    enabled" beim allerersten terraform apply nach einem Import ---

  Falls main.tf noch worker_subnet_uuid als festen Wert (aus einem
  früheren Import) enthält, diese Zeile ENTFERNEN -- bei einem neu
  erstellten Cluster darf dieses Feld nicht gesetzt werden, DO weist
  automatisch ein passendes Subnetz zu. vpc_uuid bleibt unangetastet.

--- Troubleshooting: "user_settings" Fehler bei database_user ---

  Ein bekannter API-Kurioser Fall: Beim Entfernen eines leeren
  settings{}-Blocks verlangt die DO-API ein vollständiges
  user_settings-Feld. Einfach terraform apply ein zweites Mal
  ausführen -- danach sollte "No changes" erscheinen. Betrifft nicht
  die eigentliche Funktion der User.

==================================================
TEIL 2: HELM-KOMPONENTEN INSTALLIEREN
==================================================

Diese Komponenten sind NICHT über Terraform verwaltet (bewusste
Entscheidung: Helm ist das etabliertere Werkzeug für
Kubernetes-interne Software-Installation).

--- Schritt 4: Helm-Repos hinzufügen (einmalig pro Rechner) ---

  helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
  helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
  helm repo add argo https://argoproj.github.io/argo-helm
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
  helm repo update

--- Schritt 5: ingress-nginx ---

  helm install ingress-nginx ingress-nginx/ingress-nginx --namespace ingress-nginx --create-namespace --set controller.config.use-proxy-protocol=false
  kubectl get pods -n ingress-nginx -w

  (Strg+C sobald 1/1 Running)

  kubectl get service -n ingress-nginx

  Die EXTERNAL-IP bei "ingress-nginx-controller" notieren -- wird
  gleich für die sslip.io-Hosts gebraucht. ÄNDERT SICH BEI JEDEM
  REBUILD.

--- Schritt 6: Metrics Server (Voraussetzung für HPA) ---

  helm install metrics-server metrics-server/metrics-server -n kube-system
  kubectl get pods -n kube-system | Select-String "metrics"
  kubectl top nodes

--- Schritt 7: ArgoCD ---

  kubectl create namespace argocd
  helm install argocd argo/argo-cd -n argocd
  kubectl get pods -n argocd -w

  (Strg+C sobald alle 7 Pods Running; kurzer dex-server-Neustart am
  Anfang ist normal)

  Admin-Passwort bei Bedarf:
    kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath="{.data.password}" | ...
    (unter Windows: siehe frühere Doku für PowerShell-Base64-Decode)

--- Schritt 8: kube-prometheus-stack (LÜCKE #5 -- Aufgabe 1 Observability) ---

  WICHTIG: Ohne diesen Schritt bleiben ALLE ArgoCD-Applications
  dauerhaft OutOfSync/Missing, weil chart/templates/servicemonitor.yaml
  und prometheusrule.yaml auf CRDs angewiesen sind, die nur
  kube-prometheus-stack mitbringt. Dieser Schritt fehlte in der
  ursprünglichen Kollegen-Doku komplett.

  cd <pfad>\user_mgmt_service-ops
  git pull origin main
  helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack --namespace monitoring --create-namespace -f .\monitoring\values.yaml
  kubectl get pods -n monitoring -w

  (Strg+C sobald alle 7 Pods laufen: alertmanager, grafana,
  kube-state-metrics, operator, 2x node-exporter, prometheus)

  kubectl apply -f .\monitoring\grafana-dashboard-configmap.yaml

  Verifizieren, dass das Dashboard geladen wurde:
    kubectl logs <grafana-pod-name> -n monitoring -c grafana-sc-dashboard --tail=20
  Erwartung: "Dashboards config reloaded" mit "200 OK".

==================================================
TEIL 3: ANWENDUNG DEPLOYEN
==================================================

--- Schritt 9: sslip.io-Hosts auf die aktuelle Ingress-IP aktualisieren ---

  WICHTIG: Muss bei JEDEM Rebuild angepasst werden, da sich die
  Load-Balancer-IP jedes Mal ändert. In chart/values-staging.yaml und
  chart/values-prod.yaml den host-Wert aktualisieren:

    host: staging.<NEUE-IP-MIT-PUNKTEN>.sslip.io
    host: production.<NEUE-IP-MIT-PUNKTEN>.sslip.io

  Committen und pushen nicht vergessen -- ohne Push bleibt der alte
  Wert im Cluster aktiv, ArgoCD synced korrekt den Git-Stand, aber
  wenn der Push fehlt, gibt es nichts Neues zu synken (siehe
  Troubleshooting unten).

--- Schritt 10: Managed-Database-Host in values.yaml prüfen/aktualisieren ---

  Ebenfalls bei JEDEM Rebuild nötig, da die Datenbank eine neue Host-
  Adresse bekommt:

    cd <pfad>\user_mgmt_service-infra
    terraform output postgres_host

    cd <pfad>\user_mgmt_service-ops
    (in chart/values.yaml unter postgres.managed.host den Wert
    entsprechend anpassen)

  Committen und pushen.

--- Schritt 11: Application-Manifeste anwenden ---

  cd <pfad>\user_mgmt_service-ops
  kubectl apply -f .\argocd\

  Das erstellt automatisch die Namespaces staging/production (dank
  CreateNamespace=true) UND deployt Backend/Frontend/etc.

--- Schritt 12: Secrets in beiden Namespaces anlegen ---

  WICHTIG: Reihenfolge beachten -- die Namespaces müssen existieren,
  BEVOR die Secrets erstellt werden können. Falls "namespaces not
  found" erscheint, 1-2 Minuten warten (ArgoCD muss die Namespaces
  erst per CreateNamespace anlegen) und erneut versuchen.

    kubectl get namespaces
    (staging und production müssen erscheinen)

    cd <pfad>\user_mgmt_service-infra
    $stagingPw = terraform output -raw postgres_staging_password
    $prodPw = terraform output -raw postgres_production_password
    $jwtSecretStaging = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
    $jwtSecretProd = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

    kubectl create secret generic app-secret --from-literal=SPRING_DATASOURCE_PASSWORD=$stagingPw --from-literal=JWT_SECRET=$jwtSecretStaging -n staging
    kubectl create secret generic app-secret --from-literal=SPRING_DATASOURCE_PASSWORD=$prodPw --from-literal=JWT_SECRET=$jwtSecretProd -n production

  HINWEIS: Die GRANT-Rechte (Postgres 16 Schema-Permissions) sind
  bereits automatisch durch die Terraform-Jobs aus Teil 1 gesetzt --
  hier ist KEIN manueller GRANT-Schritt mehr nötig (anders als bei
  früheren, undokumentierten Rebuilds).

--- Schritt 13: Sync-Status final prüfen ---

  kubectl get applications -n argocd

  ERWARTUNG: user-mgmt-service-staging UND user-mgmt-service-production
  beide "Synced" / "Healthy". Falls "OutOfSync"/"Progressing" hängen
  bleibt, Sync manuell erzwingen:

    kubectl annotate application user-mgmt-service-staging -n argocd argocd.argoproj.io/refresh=hard --overwrite
    kubectl annotate application user-mgmt-service-production -n argocd argocd.argoproj.io/refresh=hard --overwrite

  Falls IMMER NOCH nicht: kubectl describe application <name> -n argocd
  und den Abschnitt "Message:" unter "Operation State:" lesen -- zeigt
  die exakte Fehlerursache.

==================================================
TEIL 4: FUNKTIONSTEST
==================================================

--- Schritt 14: Login/Registrierung im Browser ---

  http://staging.<AKTUELLE-IP>.sslip.io/signup
  http://production.<AKTUELLE-IP>.sslip.io/signup

  Registrieren, einloggen. Sollte ohne Fehler funktionieren.

--- Troubleshooting: 403 Forbidden beim Registrieren/Login ---

  NICHT vorschnell an Spring Security denken (typische Fehlspur, hat
  in dieser Session viel Zeit gekostet). Meist liegt die Ursache
  woanders:

  1. Zuerst Backend-Logs prüfen:
     kubectl logs deployment/backend -n staging --tail=50

  2. Falls "relation ... does not exist" oder "permission denied for
     schema public": Datenbank-Verbindungsproblem, siehe LÜCKE #6.
     Falls die Terraform-GRANT-Jobs korrekt gelaufen sind (siehe Teil
     1), sollte das nicht mehr auftreten.

  3. Falls "connection refused"/"UnknownHostException": ConfigMap
     enthält vermutlich einen veralteten DB-Host (siehe Schritt 10)
     ODER der lokale Fix wurde nur lokal geändert, aber nie committet
     -- IMMER "git status" prüfen, bevor man von einem "gepushten"
     Fix ausgeht.

  4. Erst wenn beides ausgeschlossen ist, an Security-Filter denken.

--- Troubleshooting: 404 Not Found (nginx) auf der gesamten Seite ---

  Die aufgerufene URL/IP stimmt nicht mit dem in der Ingress-Regel
  hinterlegten Host überein. Meist: Load-Balancer-IP hat sich seit dem
  letzten sslip.io-Host-Update geändert (siehe Schritt 9).

==================================================
BEKANNTE, DAUERHAFT BEHOBENE LÜCKEN (Referenz)
==================================================

Diese sechs Punkte waren bei früheren Rebuilds unbekannt/undokumentiert
und sind jetzt in Terraform/Chart fest verankert bzw. hier dokumentiert:

LÜCKE #1 -- ingress-nginx-Installation: nie in der ursprünglichen
  Kollegen-Doku dokumentiert. Jetzt: Schritt 5 dieses Runbooks.

LÜCKE #2 -- Metrics Server: kein Standardbestandteil eines DOKS-
  Clusters, aber für HPA zwingend nötig. Jetzt: Schritt 6.

LÜCKE #3 -- NetworkPolicy blockierte Ingress-Traffic: chart/templates/
  networkpolicy.yaml brauchte einen zweiten ingress-Block mit
  namespaceSelector für den ingress-nginx-Namespace. Bereits im Chart
  behoben (Commit im Ops-Repo), kein manueller Schritt mehr nötig.

LÜCKE #4 -- Fehlende INTERNAL_API_URL im Frontend-Deployment-Template:
  verhinderte Login/Registrierung über die Next.js-eigenen API-Routen.
  Bereits im Chart behoben.

LÜCKE #5 -- kube-prometheus-stack-Installation fehlte komplett in
  jeder bisherigen Rebuild-Doku. Jetzt: Schritt 8 dieses Runbooks.

LÜCKE #6 -- Postgres 16 verlangt explizite GRANT ALL ON SCHEMA public
  für Nicht-Superuser-Rollen (frühere Postgres-Versionen hatten das
  automatisch offen). Ursprünglich manuell gefixt, jetzt DAUERHAFT in
  Terraform verankert (grants.tf, kubernetes_job_v1-Ressourcen) --
  läuft automatisch bei jedem terraform apply mit, KEIN manueller
  Schritt mehr nötig.

==================================================
TIPP: PowerShell-Escaping-Falle bei psql/curl-Tests INNERHALB von Pods
==================================================

Befehle wie "kubectl exec ... -- sh -c 'curl ... -d {\"key\":\"value\"}'"
scheitern in PowerShell fast immer an mehrfach verschachteltem
Anführungszeichen-Escaping. ZUVERLÄSSIGER: Einen simplen Test-Pod mit
"sleep 3600" als Command starten, per "kubectl exec -it <pod> -- sh"
INTERAKTIV reingehen, und Befehle direkt in der Linux-Shell eintippen.

  @'
  apiVersion: v1
  kind: Pod
  metadata:
    name: psql-debug
    namespace: staging
  spec:
    restartPolicy: Never
    containers:
      - name: psql-debug
        image: postgres:16-alpine
        command: ["sleep", "3600"]
        resources:
          requests: { cpu: 50m, memory: 32Mi }
          limits: { cpu: 200m, memory: 64Mi }
  '@ | Set-Content -Path .\psql-debug.yaml -Encoding utf8

  kubectl apply -f .\psql-debug.yaml
  kubectl exec -it psql-debug -n staging -- sh

  # Danach direkt in der Shell, z.B.:
  # psql "postgresql://user:pass@host:port/db?sslmode=require" -c "\dt"

Aufräumen nicht vergessen:
  kubectl delete -f .\psql-debug.yaml
  Remove-Item .\psql-debug.yaml

Gleiches Prinzip gilt für Terraform local-exec-Provisioner: Diese
laufen auf dem LOKALEN Rechner, nicht im Cluster -- bei Firewall-
Regeln, die nur Cluster-internen Traffic erlauben (type = "k8s"),
schlägt local-exec IMMER mit "Connection timed out" fehl. Lösung:
kubernetes_job_v1-Ressource nutzen (läuft im Cluster), siehe grants.tf
im Infra-Repo als Referenzbeispiel.

==================================================
KOSTEN-HINWEIS BEIM LÖSCHEN
==================================================

  cd <pfad>\user_mgmt_service-infra
  terraform plan -destroy   (zur Kontrolle, sollte 9 to destroy zeigen:
                              Cluster, DB-Cluster, 2 DBs, 2 User,
                              Firewall, 2 GRANT-Jobs)
  terraform destroy

Danach IMMER zusätzlich im DigitalOcean-Webportal prüfen (Droplets,
Load Balancers, Volumes) -- auch mit destroy_all_associated_resources
= true kann es in Einzelfällen zu Verzögerungen bei der Bereinigung
kommen. Erst wenn dort alles leer ist, ist wirklich keine Kostenquelle
mehr aktiv.

WICHTIG: Ein von Terraform komplett unabhängiger, alter Droplet
("Docker-VM-VSC", aus der ursprünglichen Containerisierungsphase ohne
Kubernetes) muss GESONDERT und MANUELL geprüft/gelöscht werden, falls
er nicht mehr gebraucht wird -- terraform destroy kann ihn nicht
erfassen, da er nie von Terraform verwaltet wurde.
