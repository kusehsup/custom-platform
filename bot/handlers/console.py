import asyncio
from aiogram import Router, Bot
from aiogram.types import CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton

from ..sessions import get_session

router = Router()

# user_id -> буфер консоли
_console_buffers: dict[int, list[str]] = {}
_console_tasks: dict[int, asyncio.Task] = {}


def stop_console_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text='⏹ Остановить трансляцию', callback_data='console_stop')]
    ])


@router.callback_query(lambda c: c.data == 'console')
async def handle_console(callback: CallbackQuery, bot: Bot):
    user_id = callback.from_user.id
    client = get_session(user_id)
    if not client:
        await callback.answer('Вы не авторизованы. Введите /start', show_alert=True)
        return

    if user_id in _console_tasks:
        await callback.answer('Трансляция уже запущена.', show_alert=True)
        return

    await callback.answer()
    _console_buffers[user_id] = []

    status_msg = await callback.message.answer(
        '🖥 Трансляция консоли запущена...',
        reply_markup=stop_console_kb(),
    )

    def on_log(data: str):
        _console_buffers[user_id].append(data)

    client.on('server_log', on_log)

    async def flush_loop():
        try:
            while True:
                await asyncio.sleep(3)
                buf = _console_buffers.get(user_id, [])
                if not buf:
                    continue
                text = ''.join(buf)
                _console_buffers[user_id] = []
                if len(text) > 3500:
                    text = text[-3500:]
                try:
                    await bot.send_message(
                        user_id,
                        f'<pre>{text}</pre>',
                        parse_mode='HTML',
                    )
                except Exception:
                    pass
        except asyncio.CancelledError:
            client.off('server_log', on_log)
            _console_buffers.pop(user_id, None)

    task = asyncio.create_task(flush_loop())
    _console_tasks[user_id] = task


@router.callback_query(lambda c: c.data == 'console_stop')
async def handle_console_stop(callback: CallbackQuery):
    user_id = callback.from_user.id
    task = _console_tasks.pop(user_id, None)
    if task:
        task.cancel()
    await callback.answer('Трансляция остановлена.')
    await callback.message.edit_text('⏹ Трансляция консоли остановлена.')
