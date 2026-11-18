# Kara

_Kara_ as in "empty", as in karaoke. Take the vocal out of a song, change its key and sing along to the
backing. Made for the singers of Vocalist Insight, and anyone else who wants it.

Everything runs on your own computer. There is no account and no server that sees your music, and
nothing is uploaded.

## Two ways to use it

**On the web, with a file you own.** Open [kara.leeguanfeng.com](https://kara.leeguanfeng.com), drop in a
song from your own folder, and Kara Studio separates it in your browser. Set each part's level, change the
key, play the mix and save the backing as a WAV file.

**In Chrome, over YouTube.** The extension adds the same vocal switch, key change and mixer to the video you
are already watching, so you can sing to the backing track.

## Install the Chrome extension

[**Download kara-stable.zip**](https://github.com/lgf2111/kara/releases/latest/download/kara-stable.zip)
(about 90 MB, because the separation model is inside it). It works in Chrome 116 or newer, and in Edge and Brave.

Kara is not in the Chrome Web Store, so Chrome loads it from a folder:

1. Unzip it somewhere permanent, for example `Documents/Kara`. Chrome reads the extension from this folder
   every time it starts, so do not move or delete it.
2. Open `chrome://extensions` in the address bar.
3. Turn on **Developer mode** (top right). It has to stay on.
4. Click **Load unpacked** and choose the folder that has `manifest.json` directly inside it.

The same steps, with a bit more detail, are at
[kara.leeguanfeng.com/extension](https://kara.leeguanfeng.com/extension/).

### Using it

1. Open a YouTube video and press **Start karaoke** in the panel at the bottom left of the player.
2. Wait for the bar. A four-minute song takes a minute or two with a GPU, longer without.
3. Switch to **Instrumental**. Each part has its own level, mute and solo.
4. Move the key up or down to fit your voice.
5. Press **Download** to save what you are hearing as a WAV, in the key it is playing in.

### Updating

There are no automatic updates. To take a new version, download the latest zip, unzip it over the old
folder and press reload on Kara's card in `chrome://extensions`.

## Privacy

Audio is decoded, separated and played on your machine. The website's security policy lets the page talk to
its own origin only, so there is nothing for it to upload to. What you share with a friend is a recipe of
timings and settings, never audio.

## What Kara is not

Kara helps you sing the music you already own or are already playing. It is not a way to acquire music, and
it does not host, store or redistribute any.

## Licences

The package contains the htdemucs separation model. Its licence and the other notices are in the `NOTICE`
and `LICENSE` files inside the zip.

## Problems

Open an [issue](https://github.com/lgf2111/kara/issues) and say what you did, what you expected and what
happened. Your browser and version help.
