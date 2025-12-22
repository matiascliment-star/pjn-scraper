# PJN Scraper - Novedades Diarias

Scraper automatizado para el Sistema de Consulta Web (SCW) del Poder Judicial de la Nación.

## 🚀 Deploy en Railway

El scraper está deployado en Railway y expone los siguientes endpoints:

### Endpoints disponibles

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/pjn/novedades-diarias` | POST | Actualización diaria de novedades |
| `/pjn/importar-movimientos-masivo` | POST | Importación masiva inicial |
| `/pjn/movimientos` | POST | Movimientos de un expediente |
| `/pjn/buscar` | POST | Buscar expedientes |

## ⚙️ Configuración del Cron en GitHub

### 1. Crear repositorio en GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/TU_USUARIO/pjn-scraper.git
git push -u origin main
```

### 2. Configurar Secrets en GitHub

Ir a: **Settings → Secrets and variables → Actions → New repository secret**

Agregar los siguientes secrets:

| Secret | Valor |
|--------|-------|
| `SCRAPER_URL` | `https://pjn-scraper-production.up.railway.app` |
| `PJN_USUARIO` | Tu CUIT (ej: `20313806198`) |
| `PJN_PASSWORD` | Tu contraseña del SCW |

### 3. Verificar el Workflow

El cron se ejecuta automáticamente todos los días a las **6:00 AM Argentina**.

Para ejecutar manualmente:
1. Ir a **Actions** → **PJN Novedades Diarias**
2. Click en **Run workflow**

## 📊 Variables de entorno en Railway

```
SUPABASE_URL=https://wdgdbbcwcrirpnfdmykh.supabase.co
SUPABASE_KEY=tu_key_de_supabase
PORT=8080
```

## 🔄 Flujo del Cron Diario

1. **8:00 AM Argentina** - Se dispara el cron
2. Login en SCW con las credenciales
3. Obtiene lista completa de expedientes del SCW
4. Matchea con expedientes CABA en Supabase
5. Para cada expediente matcheado:
   - Obtiene los últimos 15 movimientos
   - Compara con existentes
   - Guarda solo los nuevos
6. Genera resumen con novedades encontradas

## 📁 Estructura

```
pjn-scraper/
├── .github/
│   └── workflows/
│       └── novedades-diarias.yml   # Cron de GitHub Actions
├── scrapers/
│   ├── mev.js                       # Scraper MEV (Provincia)
│   └── pjn.js                       # Scraper PJN (CABA)
├── server.js                        # Servidor Express
├── package.json
├── Dockerfile
└── README.md
```

## 🛠️ Desarrollo local

```bash
# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env
# Editar .env con tus credenciales

# Ejecutar
npm start
```

## 📝 Logs

Los logs del cron se pueden ver en:
- **GitHub Actions** → Seleccionar la ejecución → Ver logs
- **Railway** → Deployments → Logs

## ⚠️ Notas importantes

- El SCW limita las sesiones concurrentes, por eso se procesan de a 4 expedientes
- El cron tiene timeout de 60 minutos
- Si hay más de ~800 expedientes, el proceso puede demorar 30-40 minutos
- Los movimientos se deduplican automáticamente por `(expediente_id, fecha, tipo, descripcion)`
