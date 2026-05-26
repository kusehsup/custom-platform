from aiogram import Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import Message

from hassle_platform import PlatformClient
from ..sessions import get_session, set_session
from ..keyboards import main_menu

router = Router()


class LoginStates(StatesGroup):
    waiting_login = State()
    waiting_password = State()


@router.message(Command('start'))
async def cmd_start(message: Message, state: FSMContext):
    client = get_session(message.from_user.id)
    if client and client._connected:
        status = client.server_status
        await message.answer(
            '✅ Вы уже авторизованы на платформе.',
            reply_markup=main_menu(status),
        )
        return

    await message.answer('Введите логин для входа на платформу:')
    await state.set_state(LoginStates.waiting_login)


@router.message(LoginStates.waiting_login)
async def process_login(message: Message, state: FSMContext):
    await state.update_data(login=message.text)
    await message.answer('Введите пароль:')
    await state.set_state(LoginStates.waiting_password)


@router.message(LoginStates.waiting_password)
async def process_password(message: Message, state: FSMContext):
    data = await state.get_data()
    login = data['login']
    password = message.text

    await message.answer('⏳ Подключаемся к платформе...')

    client = PlatformClient()
    try:
        connected = await client.connect()
    except Exception as e:
        await message.answer(f'❌ Не удалось подключиться к платформе:\n<code>{e}</code>', parse_mode='HTML')
        await state.clear()
        return

    if not connected:
        await message.answer('❌ Ошибка при установке Socket.IO соединения.')
        await state.clear()
        return

    success, error = await client.login(login, password)
    if not success:
        await client.disconnect()
        await message.answer(f'❌ Ошибка авторизации: {error}\n\nПопробуйте снова — /start')
        await state.clear()
        return

    set_session(message.from_user.id, client)
    await state.clear()

    status = client.server_status
    await message.answer(
        f'✅ Успешный вход на платформу!\n\nСтатус сервера: {"🟢 Работает" if status == "on" else "🔴 Выключен"}',
        reply_markup=main_menu(status),
    )
