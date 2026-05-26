import asyncio
from aiogram import Router, Bot
from aiogram.types import CallbackQuery

from ..sessions import get_session
from ..keyboards import main_menu

router = Router()


@router.callback_query(lambda c: c.data == 'compile')
async def handle_compile(callback: CallbackQuery, bot: Bot):
    user_id = callback.from_user.id
    client = get_session(user_id)
    if not client:
        await callback.answer('Вы не авторизованы. Введите /start', show_alert=True)
        return

    if client.is_compiling:
        await callback.answer('Компиляция уже выполняется.', show_alert=True)
        return

    await callback.answer('Запускаем компиляцию...')
    await callback.message.edit_text(
        '🔨 Компиляция запущена, ожидаем результат...',
        reply_markup=main_menu(client.server_status),
    )

    async def wait_result():
        result = await client.start_compile()
        if len(result) > 3500:
            result = '...(обрезано)\n' + result[-3500:]
        await bot.send_message(
            user_id,
            f'📋 Результат компиляции:\n<pre>{result}</pre>',
            parse_mode='HTML',
            reply_markup=main_menu(client.server_status),
        )

    asyncio.create_task(wait_result())
