# SC Like

Автор: elecktro1337 (t.me/elecktro1337)

Что делает:
- читает tracks.txt (формат: Artist - Title)
- ищет треки в SoundCloud
- кэширует найденные
- затем ставит лайки (с возобновлением)

## Установка
npm i

## Запуск
npm run start

## Важно (Redirect URI)
В настройках SoundCloud App добавь Redirect URI (например):
http://127.0.0.1:53682/callback