from javascript import require, On, Once, AsyncTask, once, off

mineflayer = require('mineflayer')
BOT_USERNAME = 'bot'

bot = mineflayer.createBot({ 'host': '127.0.0.1', 'port': 12345, 'username': BOT_USERNAME, 'hideErrors': False })

@On(bot, "spawn")
def on_spawn(*_):
    print("spawned!")



