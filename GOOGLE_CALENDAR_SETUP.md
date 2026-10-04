# Настройка Google Calendar для опубликованного планировщика

Интеграция работает прямо в браузере и не требует backend или Client Secret. OAuth Client ID — публичный идентификатор веб-приложения; access token хранится только в памяти вкладки.

## 1. Настройка проекта Google Cloud

1. Откройте [Google Cloud Console](https://console.cloud.google.com/) и выберите проект.
2. В разделе **APIs & Services → Library** включите **Google Calendar API**.
3. В **Google Auth Platform → Branding / Audience** настройте экран согласия. Для режима Testing добавьте свой Google-аккаунт в Test users.
4. В **Google Auth Platform → Clients** создайте клиент типа **Web application**.
5. В **Authorized JavaScript origins** добавьте ровно:

   `https://elenagmueller-bit.github.io`

   Путь репозитория и завершающий `/` в origin не указываются. Redirect URI для используемой token model не нужен.
6. Скопируйте полученный Client ID вида `…apps.googleusercontent.com`.

## 2. Настройка планировщика

В файле `js/config.js` вставьте Client ID в `GOOGLE_CONFIG.clientId`:

```js
clientId: "ВАШ_CLIENT_ID.apps.googleusercontent.com",
```

Client Secret в проект добавлять нельзя. После изменения опубликуйте файлы на GitHub Pages и откройте:

`https://elenagmueller-bit.github.io/moy-pervyy-planirovshchik/`

## 3. Безопасная проверка

1. Нажмите «Подключить» и разрешите чтение календарей.
2. Выберите не менее двух календарей и проверьте флажки видимости слева.
3. Для тестовой задачи включите отправку в Google; разрешение на запись запрашивается отдельно.
4. Проверьте создание, изменение и удаление на отдельном тестовом календаре.
5. Убедитесь, что у созданного события есть уведомление за 10 минут.

При смене адреса публикации новый origin нужно отдельно добавить в Google Cloud. Для локальной проверки добавляется фактический origin сервера, например `http://127.0.0.1:4173`.
