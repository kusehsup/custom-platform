from aiogram import Router
from aiogram.types import CallbackQuery

from ..sessions import get_session
from ..keyboards import main_menu

router = Router()


@router.callback_query(lambda c: c.data in ('server_start', 'server_stop', 'refresh'))
async def handle_server(callback: CallbackQuery):
    client = get_session(callback.from_user.id)
    if not client:
        await callback.answer('Вы не авторизованы. Введите /start', show_alert=True)
        return

    try:
        if callback.data == 'server_start':
            await callback.answer('Запускаем сервер...')
            await client.start_server()
            await callback.message.edit_text(
                '🟢 Сервер запущен.',
                reply_markup=main_menu(client.server_status),
            )

        elif callback.data == 'server_stop':
            await callback.answer('Останавливаем сервер...')
            await client.stop_server()
            await callback.message.edit_text(
                '🔴 Сервер остановлен.',
                reply_markup=main_menu(client.server_status),
            )

        elif callback.data == 'refresh':
            status = client.server_status
            await callback.answer('Обновлено')
            await callback.message.edit_text(
                f'Статус сервера: {"🟢 Работает" if status == "on" else "🔴 Выключен"}',
                reply_markup=main_menu(status),
            )
    except ConnectionError as e:
        await callback.answer(str(e), show_alert=True)
