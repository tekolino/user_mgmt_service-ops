==================================================
ÜBERGABE: TERRAFORM-MIGRATION + LÜCKENSCHLIESSUNG (15.09.2026)
==================================================

ZWECK DIESES DOKUMENTS: Vollständige Zusammenfassung dessen, was heute
gemacht wurde, für Teammitglieder und deren KI-Sessions. Bitte
komplett lesen, bevor am Projekt weitergearbeitet wird -- mehrere
grundlegende Dinge haben sich seit den letzten Zusammenfassungen
geändert (Datenbank-Migration zu Terraform, mehrere neu gefundene und
behobene Bugs).

WICHTIGSTES DOKUMENT FÜR KÜNFTIGE REBUILDS:
docs/RUNBOOK_v2_Terraform.md im Ops-Repo -- ersetzt alle älteren
Runbook-Versionen. Bei jedem Cluster-Neuaufbau diesem Dokument Schritt
für Schritt folgen.

==================================================
REPOSITORIES (aktueller Stand)
==================================================

- Core-Repo (Code + Pipeline): https://github.com/thinu-teko/user_mgmt_service
- Ops-Repo (Helm Chart + ArgoCD Manifeste + Runbook): https://github.com/tekolino/user_mgmt_service-ops
- Infra-Repo (Terraform, NEU seit heute vollständig funktionsfähig): https://github.com/tekolino/user_mgmt_service-infra

Alle drei Repos sind aktuell "clean" (nichts uncommitted), Stand nach
dieser Sitzung.

==================================================
WAS HEUTE GEMACHT WURDE -- ÜBERBLICK
==================================================

1. Der zuvor bestehende, per Terraform-Import übernommene Cluster
   wurde komplett gelöscht (kostenintensiv, ungenutzt über Nacht).
2. Cluster UND Managed Database wurden komplett NEU über Terraform
   erstellt (nicht mehr importiert -- reiner "from scratch"-Aufbau).
3. Dabei wurden SECHS grundlegende, bisher unbekannte oder
   undokumentierte Lücken gefunden und behoben (Details unten).
4. Der komplette Aufbauprozess wurde bis zum erfolgreichen Login in
   BEIDEN Umgebungen (staging + production) verifiziert.
5. Cluster + Datenbank wurden am Ende erneut komplett gelöscht
   (Kostenersparnis) -- aktuell existiert NICHTS Kostenpflichtiges
   mehr in der DigitalOcean-Infrastruktur dieses Projekts.
6. Ein vollständig neues Runbook (RUNBOOK_v2_Terraform.md) wurde
   erstellt, das den kompletten, getesteten Ablauf dokumentiert.

==================================================
DIE SECHS GEFUNDENEN UND BEHOBENEN LÜCKEN
==================================================

--- LÜCKE #1: ingress-nginx-Installation nie dokumentiert ---

War beim ursprünglichen Cluster-Aufbau (vor dieser Sitzung) offenbar
manuell installiert worden, ohne dass der Befehl je festgehalten
wurde. Musste bei jedem Rebuild neu herausgefunden werden. JETZT:
Schritt 5 in RUNBOOK_v2_Terraform.md, via Helm (nicht mehr rohes
Community-Manifest):

  helm install ingress-nginx ingress-nginx/ingress-nginx --namespace ingress-nginx --create-namespace --set controller.config.use-proxy-protocol=false

--- LÜCKE #2: Metrics Server fehlt in jedem frischen DOKS-Cluster ---

Kein Standardbestandteil eines DigitalOcean-Kubernetes-Clusters, aber
zwingend nötig für den HPA aus Aufgabe 6 (ohne ihn bleibt
"cpu: <unknown>/70%" stehen). JETZT: Schritt 6 im Runbook.

--- LÜCKE #3: NetworkPolicy blockierte Ingress-Traffic ---

Ein vorbestehender Bug: chart/templates/networkpolicy.yaml erlaubte
nur Traffic INNERHALB desselben Namespace, blockierte damit
ungewollt auch den legitimen Traffic vom ingress-nginx-Namespace.
Führte zu "504 Gateway Time-out". BEREITS IM CHART BEHOBEN (Commit im
Ops-Repo) -- die Policy hat jetzt einen zweiten ingress-Block mit
namespaceSelector für ingress-nginx. Kein manueller Schritt mehr
nötig bei künftigen Rebuilds.

--- LÜCKE #4: Fehlende INTERNAL_API_URL im Frontend-Deployment ---

chart/templates/frontend-deployment.yaml hatte den kompletten env-Block
mit INTERNAL_API_URL verloren (vermutlich beim Hinzufügen der Probes
in Aufgabe 6 versehentlich entfernt). Führte zu "500 Internal Server
Error" bei Login/Registrierung über die Next.js-eigenen API-Routen.
BEREITS IM CHART BEHOBEN. Kein manueller Schritt mehr nötig.

--- LÜCKE #5: kube-prometheus-stack-Installation fehlte komplett ---

In KEINER bisherigen Rebuild-Dokumentation enthalten. Ohne diesen
Schritt bleiben ALLE ArgoCD-Applications dauerhaft OutOfSync/Missing,
weil chart/templates/servicemonitor.yaml und prometheusrule.yaml auf
CRDs angewiesen sind, die nur kube-prometheus-stack mitbringt
(monitoring.coreos.com/ServiceMonitor, PrometheusRule). JETZT:
Schritt 8 in RUNBOOK_v2_Terraform.md:

  helm install kube-prometheus-stack prometheus-community/kube-prometheus-stack --namespace monitoring --create-namespace -f monitoring/values.yaml
  kubectl apply -f monitoring/grafana-dashboard-configmap.yaml

--- LÜCKE #6: Postgres 16 verlangt explizite Schema-Rechte (WICHTIGSTER FUND) ---

DigitalOcean Managed Databases laufen auf PostgreSQL 16. Seit Postgres
15 ist der Zugriff auf das "public"-Schema NICHT mehr automatisch für
alle Datenbank-User freigegeben (frühere Postgres-Versionen hatten das
automatisch offen). Ohne explizites GRANT bekommt jeder Nicht-
Superuser-DB-User den Fehler "permission denied for schema public",
sobald Hibernate versucht, Tabellen anzulegen -- äussert sich im
Browser als scheinbar unzusammenhängender "403 Forbidden" bei
Login/Registrierung (WICHTIG: das ist eine Fehlspur, NICHT an Spring
Security denken, das war nicht die Ursache).

FIX: Ursprünglich manuell per psql gelöst, jetzt DAUERHAFT in
Terraform automatisiert. Im Infra-Repo liegt grants.tf mit zwei
kubernetes_job_v1-Ressourcen, die nach Erstellung von Cluster und
Datenbank automatisch je einen Kubernetes-Job ausführen, der
"GRANT ALL ON SCHEMA public TO staging_user;" bzw. für production_user
ausführt. Läuft automatisch bei JEDEM terraform apply mit -- KEIN
manueller Schritt mehr nötig.

WICHTIGER TECHNISCHER HINWEIS für Terraform-Provisioner: Ein
lokaler local-exec-Provisioner (läuft auf dem eigenen Rechner)
funktioniert HIER NICHT, weil die Datenbank-Firewall nur Traffic aus
dem Kubernetes-Cluster selbst erlaubt (type = "k8s" Regel). Deshalb
wurde stattdessen der kubernetes-Provider genutzt, der einen echten
Job INNERHALB des Clusters ausführt (siehe provider.tf für die
Provider-Konfiguration, die die Zugangsdaten automatisch aus der
digitalocean_kubernetes_cluster-Ressource bezieht).

==================================================
NEUE TERRAFORM-DATEISTRUKTUR (Infra-Repo)
==================================================

  main.tf         -- Kubernetes-Cluster-Definition
  database.tf     -- Managed PostgreSQL, 2 DBs, 2 User, Firewall
  grants.tf       -- Die zwei GRANT-Kubernetes-Jobs (LÜCKE #6 Fix)
  provider.tf     -- DigitalOcean-Provider + Kubernetes-Provider
                     (Kubernetes-Provider bezieht Zugangsdaten
                     automatisch vom selbst erstellten Cluster)
  variables.tf    -- Parametrisierte Werte (Name, Region, Version,
                     Node-Grösse/-Anzahl, DB-Grösse)
  outputs.tf      -- postgres_host, postgres_port, User/Passwörter
                     (als sensitive markiert)
  terraform.tfvars -- NUR LOKAL, nie committen (enthält do_token)
  .gitignore      -- deckt *.tfvars, *.tfstate, .terraform/ ab

HINWEIS: import.tf wurde entfernt (war nur für die einmalige
Übernahme des ursprünglichen, manuell erstellten Clusters nötig).
Alle künftigen terraform apply erstellen den Cluster als komplett
neue Ressource.

==================================================
WICHTIGE ARBEITSABLÄUFE, DIE SICH GEÄNDERT HABEN
==================================================

FRÜHER (vor heute): Cluster manuell über DigitalOcean-Weboberfläche
erstellt, Postgres selbstgehostet im Cluster.

JETZT: Cluster UND Managed Database werden gemeinsam über
"terraform apply" im Infra-Repo erstellt. Postgres läuft NICHT mehr
im Cluster, sondern als eigenständiges DigitalOcean-Produkt
(digitalocean_database_cluster).

BEI JEDEM REBUILD MÜSSEN FOLGENDE WERTE MANUELL AKTUALISIERT WERDEN
(da sie sich bei jedem Neuaufbau ändern):
1. sslip.io-Hosts in chart/values-staging.yaml und values-prod.yaml
   (neue Load-Balancer-IP)
2. postgres.managed.host in chart/values.yaml (neue DB-Host-Adresse)
3. app-secret in staging und production (neue DB-Passwörter aus
   terraform output, neue zufällige JWT-Secrets)

Alle drei Schritte sind im RUNBOOK_v2_Terraform.md unter Schritt 9,
10 und 12 im Detail beschrieben.

==================================================
AKTUELLER STAND: NICHTS LÄUFT MEHR (Kostenersparnis)
==================================================

Cluster und Datenbank wurden am Ende dieser Sitzung bewusst wieder
komplett gelöscht (terraform destroy, 9 Ressourcen). Bestätigt über:
  doctl kubernetes cluster list   -> leer
  doctl databases list            -> leer
  DigitalOcean-Webportal (Droplets, Load Balancers, Volumes) -> leer

WICHTIG: Der von Terraform komplett unabhängige, alte Droplet
("Docker-VM-VSC", aus der ursprünglichen Containerisierungsphase ohne
Kubernetes) wurde in einer früheren Sitzung bereits gelöscht.

Für den nächsten Arbeitsbeginn: RUNBOOK_v2_Terraform.md Schritt für
Schritt folgen, beginnend mit "terraform apply" im Infra-Repo.
Realistische Dauer bis zum vollständig funktionierenden System:
ca. 30-40 Minuten.

==================================================
STATUS ALLER AUFGABEN (Observability-Phase)
==================================================

Aufgabe 1 (Observability): erledigt, heute erneut über
  kube-prometheus-stack + Grafana-Dashboard bestätigt (Lücke #5 löste
  das ursprüngliche Rebuild-Problem)
Aufgabe 2 (Chaos Testing / k6): erledigt (von Kollegen umgesetzt,
  nicht Teil der heutigen Sitzung, load-testing/ Ordner im Ops-Repo
  weiterhin vorhanden)
Aufgabe 3 (Terraform IaC): erledigt UND heute grundlegend erweitert
  -- ursprünglich nur Cluster-Import, jetzt vollständige Infrastruktur
  (Cluster + Managed Database + GRANT-Automatisierung) komplett aus
  Code reproduzierbar
Aufgabe 4 (Managed Resources): erledigt -- Managed PostgreSQL
  Database ersetzt den selbstgehosteten Postgres-Pod vollständig,
  heute nochmals komplett von Grund auf neu bestätigt
Aufgabe 5 (Kyverno Policy as Code): NOCH NICHT begonnen -- nächster
  logischer Schritt
Aufgabe 6 (Microservices, 40% der Note): NOCH NICHT begonnen

==================================================
WICHTIGE SICHERHEITSHINWEISE
==================================================

1. app-secret existiert nur direkt im Cluster, nie im Git-Repo. Bei
   jedem Rebuild werden neue, zufällige Werte generiert.
2. terraform.tfvars (enthält DigitalOcean API-Token) existiert nur
   lokal, nie committen -- durch .gitignore abgesichert.
3. Im Verlauf dieser Sitzung wurden aus Zeitgründen bewusst mehrfach
   Datenbank-Passwörter im Klartext im Chat-Verlauf geteilt (informierte
   Entscheidung, da reine Testdaten ohne Produktivwert). Für ein
   Projekt mit echten Daten wäre das NICHT akzeptabel -- bitte bei
   künftiger Arbeit wieder zur strikten Geheimhaltung zurückkehren.
4. ArgoCD Admin-Passwort: jede Person holt sich das bei Bedarf selbst
   frisch aus dem Cluster, wird nicht herumgereicht.
5. Keine Secrets/Tokens unnötig in Chats mit KI-Tools einfügen.

==================================================
EMPFEHLUNG FÜR DIE NÄCHSTE SITZUNG
==================================================

1. RUNBOOK_v2_Terraform.md Schritt für Schritt durcharbeiten (ca.
   30-40 Min bis zum funktionierenden System).
2. Danach direkt mit Aufgabe 5 (Kyverno Policy as Code) beginnen --
   siehe Aufgabenblatt für Akzeptanzkriterien (Kyverno via Helm im
   Namespace "policy", mindestens 3 ClusterPolicies, Nachweis über
   ein absichtlich ungültiges Manifest, das abgelehnt wird).
3. Bei JEDEM neuen, unerwarteten Fehler: NICHT vorschnell zu einer
   Ursache springen (z.B. "das ist bestimmt Security" oder "das ist
   bestimmt ein Netzwerkproblem"). Erst Logs/Events GEZIELT und
   VOLLSTÄNDIG lesen (nicht nur --tail, sondern mit Select-String nach
   den relevanten Stichworten filtern), dann erst Fixes versuchen.
   Diese Sitzung hat mehrfach gezeigt, dass die erste Vermutung oft
   falsch war und die eigentliche Ursache erst nach genauerem
   Hinschauen sichtbar wurde.
