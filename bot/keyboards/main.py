from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton


def main_menu(server_status: str) -> InlineKeyboardMarkup:
    server_btn = (
        InlineKeyboardButton(text='🔴 Остановить сервер', callback_data='server_stop')
        if server_status == 'on'
        else InlineKeyboardButton(text='🟢 Запустить сервер', callback_data='server_start')
    )
    return InlineKeyboardMarkup(inline_keyboard=[
        [server_btn],
        [InlineKeyboardButton(text='🔨 Компилировать', callback_data='compile')],
        [InlineKeyboardButton(text='🖥 Консоль', callback_data='console')],
        [InlineKeyboardButton(text='🔄 Обновить статус', callback_data='refresh')],
    ])
