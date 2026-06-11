"""
Каталог внешних команд, поддерживаемых Pawn-сервером
(см. input data/external_commands.pwn).

Для каждой команды описаны:
  - id (значение enum'а на стороне Pawn)
  - name (символическое имя для UI)
  - group (тематическая группа)
  - description (что делает команда)
  - supports_wait_response (можно ли использовать command_type=2)
  - fields: list[dict] — какие поля заполнять. Каждое поле:
      key:        'data_1'..'data_4' | 'data_string_1'
      label:      подпись для UI
      type:       'int' | 'bool' | 'string' | 'json' | 'enum'
      required:   bool
      options:    [{value, label}]  — для type='enum'
      hint:       короткое уточнение (плейсхолдер/подсказка)
      min/max:    границы для int (опционально)
      default:    значение по умолчанию (опционально)

UI рендерит только те поля, которые описаны.
Если у команды нет описанных полей — она вызывается «как есть» без данных.
"""
from __future__ import annotations
from typing import Any


# ── Общие подсказки полей ────────────────────────────────────────────
# Используются для команд, где поле имеет тривиальный смысл.

def _int(key: str, label: str, *, required: bool = True, hint: str = '',
         minimum: int | None = None, maximum: int | None = None,
         default: int | None = None) -> dict[str, Any]:
    field: dict[str, Any] = {
        'key': key, 'label': label, 'type': 'int', 'required': required,
    }
    if hint:
        field['hint'] = hint
    if minimum is not None:
        field['min'] = minimum
    if maximum is not None:
        field['max'] = maximum
    if default is not None:
        field['default'] = default
    return field


def _bool(key: str, label: str, *, hint: str = '') -> dict[str, Any]:
    return {'key': key, 'label': label, 'type': 'bool', 'required': True, 'hint': hint}


def _str(key: str, label: str, *, required: bool = True, hint: str = '',
         maxlen: int = 256) -> dict[str, Any]:
    field: dict[str, Any] = {
        'key': key, 'label': label, 'type': 'string', 'required': required,
        'maxlen': maxlen,
    }
    if hint:
        field['hint'] = hint
    return field


def _enum(key: str, label: str, options: list[dict[str, Any]], *,
          hint: str = '') -> dict[str, Any]:
    return {
        'key': key, 'label': label, 'type': 'enum', 'required': True,
        'options': options, 'hint': hint,
    }


# ── Каталог команд ──────────────────────────────────────────────────
# Порядок здесь — порядок отображения в UI внутри группы.
# Если команда здесь не описана, её всё равно можно отправить через
# «Сырой режим» (отдельный пункт в UI).

CATALOG: list[dict[str, Any]] = [
    # ── Игроки ──────────────────────────────────────────────────────
    {
        'id': 0, 'name': 'COMMAND_KICK', 'group': 'Игроки',
        'description': 'Кикнуть игрока с сервера. Достаточно указать имя ИЛИ SQL ID.',
        'supports_wait_response': True,
        'fields': [
            _str('data_string_1', 'Имя игрока', required=False, hint='Nick_Name', maxlen=24),
            _int('data_1', 'SQL ID игрока', required=False, hint='Если имя не указано'),
        ],
    },
    {
        'id': 63, 'name': 'COMMAND_PLAYER_BAN', 'group': 'Игроки',
        'description': 'Бан игрока (подробности в ProcessExternalBan).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'SQL ID игрока'),
            _int('data_2', 'Длительность (сек)', hint='-1 — навсегда'),
            _str('data_string_1', 'Причина'),
        ],
    },
    {
        'id': 15, 'name': 'COMMAND_SET_BAN_IP', 'group': 'Игроки',
        'description': 'Забанить или разбанить IP. data_string_1 — JSON-массив [ip, admin_id, reason].',
        'supports_wait_response': True,
        'fields': [
            _enum('data_1', 'Действие', [
                {'value': 1, 'label': 'Забанить'},
                {'value': 0, 'label': 'Разбанить'},
            ]),
            _int('data_2', 'Длительность (сек)', hint='1000 = навсегда; иначе — секунды от текущего времени'),
            _str('data_string_1', 'JSON [ip, admin_id, reason]',
                 hint='Например: ["1.2.3.4","42","Cheat"]'),
        ],
    },
    {
        'id': 39, 'name': 'COMMAND_RESET_PLAYER_SOCIALS', 'group': 'Игроки',
        'description': 'Сбросить привязки Telegram и VK у игрока.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'SQL ID аккаунта')],
    },
    {
        'id': 17, 'name': 'COMMAND_CHECK_PLAYER_DONATE', 'group': 'Игроки',
        'description': 'Проверка доната или непогашенного пакета у онлайн-игрока.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'SQL ID аккаунта'),
            _enum('data_2', 'Тип проверки', [
                {'value': 0, 'label': 'Donate'},
                {'value': 1, 'label': 'Package'},
            ]),
        ],
    },
    {
        'id': 76, 'name': 'COMMAND_REMOVE_DONATE', 'group': 'Игроки',
        'description': 'Списать донат у игрока по имени.',
        'supports_wait_response': True,
        'fields': [
            _str('data_string_1', 'Имя игрока', maxlen=24),
            _int('data_1', 'Сколько списать', minimum=1),
        ],
    },
    {
        'id': 62, 'name': 'COMMAND_GIVE_PLAYER_REWARD', 'group': 'Игроки',
        'description': 'Выдать награду игроку. data_string_1 — JSON с описанием награды (формат на стороне сервера).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'SQL ID аккаунта'),
            _str('data_string_1', 'JSON награды', maxlen=512),
        ],
    },
    {
        'id': 40, 'name': 'COMMAND_ERROR_ALERT_PROTECTION', 'group': 'Игроки',
        'description': 'Сообщить онлайн-игроку об ошибке защиты (ServiceAlert).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'SQL ID аккаунта'),
            _str('data_string_1', 'Причина', maxlen=32),
        ],
    },
    {
        'id': 44, 'name': 'COMMAND_TELEGRAM_TEMP_BAN', 'group': 'Игроки',
        'description': 'Временный бан Telegram-связи для аккаунта.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'SQL ID аккаунта')],
    },
    {
        'id': 41, 'name': 'COMMANE_REGISTRATION_PLAYER', 'group': 'Игроки',
        'description': 'Внешняя регистрация игрока (формат строки — на стороне сервера).',
        'supports_wait_response': True,
        'fields': [_str('data_string_1', 'Payload (строка)', maxlen=512)],
    },
    {
        'id': 43, 'name': 'COMMAND_GIVEAWAY_WEB_AUTH', 'group': 'Игроки',
        'description': 'Обновить статус веб-авторизации для giveaway.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'SQL ID аккаунта'),
            _enum('data_2', 'Статус', [
                {'value': 0, 'label': '0 — выключить'},
                {'value': 1, 'label': '1 — включить'},
            ]),
        ],
    },
    {
        'id': 55, 'name': 'COMMAND_START_SCREAMER_PLAYER', 'group': 'Игроки',
        'description': 'Запустить «скример» онлайн-игроку (Helloween).',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'SQL ID аккаунта')],
    },
    {
        'id': 98, 'name': 'COMMAND_SET_PLAYER_NOTIFICATION', 'group': 'Игроки',
        'description': 'Установить персональное уведомление игроку.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'SQL ID аккаунта'),
            _str('data_string_1', 'Текст / payload', maxlen=512),
        ],
    },

    # ── Сервер ──────────────────────────────────────────────────────
    {
        'id': 3, 'name': 'COMMAND_RESTART', 'group': 'Сервер',
        'description': 'Запланировать рестарт сервера через N секунд. -1 — отменить.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Через сколько секунд', hint='-1 — отменить рестарт')],
    },
    {
        'id': 4, 'name': 'COMMAND_SET_CLIENT_VERSION', 'group': 'Сервер',
        'description': 'Минимальная допустимая версия клиента.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Версия')],
    },
    {
        'id': 5, 'name': 'COMMAND_SET_CAPTCHA_TYPE', 'group': 'Сервер',
        'description': 'Тип captcha (значение из g_captcha_current_type).',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Тип')],
    },
    {
        'id': 6, 'name': 'COMMAND_SET_HARDWARE_ID_CHECK', 'group': 'Сервер',
        'description': 'Включить/выключить проверку Hardware ID.',
        'supports_wait_response': True,
        'fields': [_bool('data_1', 'Проверять hardware ID')],
    },
    {
        'id': 7, 'name': 'COMMAND_CHECK_BAN_HARDWARE', 'group': 'Сервер',
        'description': 'Включить/выключить проверку банов по HWID.',
        'supports_wait_response': True,
        'fields': [_bool('data_1', 'Проверять баны hwid')],
    },
    {
        'id': 9, 'name': 'COMMAND_CHANGE_HARDWARE_COUNT', 'group': 'Сервер',
        'description': 'Максимальное число hardware ID на аккаунт.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Кол-во', minimum=0)],
    },
    {
        'id': 10, 'name': 'COMMAND_SECURITY_AGE_STATUS', 'group': 'Сервер',
        'description': 'Изменить настройку проверки возраста (SA_SYSTEM_DISABLE).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'Тип SecurityAge'),
            _enum('data_2', 'Выключить?', [
                {'value': 0, 'label': '0 — включить'},
                {'value': 1, 'label': '1 — выключить'},
            ]),
        ],
    },
    {
        'id': 12, 'name': 'COMMAND_SET_BLOCK_EVICT', 'group': 'Сервер',
        'description': 'Глобальная блокировка выселений (BLOCK_EVICT).',
        'supports_wait_response': True,
        'fields': [_enum('data_1', 'Значение', [
            {'value': 0, 'label': '0 — выселения работают'},
            {'value': 1, 'label': '1 — выселения заблокированы'},
        ])],
    },
    {
        'id': 13, 'name': 'COMMAND_SET_ANTICHEAT', 'group': 'Сервер',
        'description': 'Настройка одного слота античита.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'Индекс'),
            _int('data_2', 'Статус'),
            _int('data_3', 'Warnings'),
        ],
    },
    {
        'id': 20, 'name': 'COMMAND_CHANGE_EXTRA_ANTICHEAT', 'group': 'Сервер',
        'description': 'Изменить extra params слота античита.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'Индекс'),
            _int('data_2', 'Extra params'),
        ],
    },
    {
        'id': 81, 'name': 'COMMAND_RELOAD_ANTICHEAT_CONFIG', 'group': 'Сервер',
        'description': 'Перечитать конфиг античита.',
        'supports_wait_response': True,
        'fields': [],
    },
    {
        'id': 14, 'name': 'COMMAND_SET_DONATION_COURSE', 'group': 'Сервер',
        'description': 'Курс доната в процентах (0 и выше).',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Курс, %', minimum=0)],
    },
    {
        'id': 16, 'name': 'COMMAND_SET_CDN_LOGO_URL', 'group': 'Сервер',
        'description': 'Установить URL CDN-логотипа.',
        'supports_wait_response': True,
        'fields': [_str('data_string_1', 'URL', maxlen=256)],
    },
    {
        'id': 50, 'name': 'COMMAND_ENTER_NEWS_UPDATE_TIME', 'group': 'Сервер',
        'description': 'Timestamp последнего обновления новостей входа.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Unix timestamp', minimum=0)],
    },
    {
        'id': 49, 'name': 'COMMAND_FEATURE_FLAG', 'group': 'Сервер',
        'description': 'Создать или обновить feature-флаг.',
        'supports_wait_response': True,
        'fields': [
            _str('data_string_1', 'Имя флага', maxlen=32),
            _int('data_1', 'End time (unix)'),
            _enum('data_2', 'Статус', [
                {'value': 0, 'label': '0 — выключен'},
                {'value': 1, 'label': '1 — включён'},
            ]),
        ],
    },
    {
        'id': 67, 'name': 'COMMAND_TRUST_FACTOR', 'group': 'Сервер',
        'description': 'TrustFactor:OnExternalCommand(action_type, value).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'Тип действия'),
            _int('data_2', 'Значение'),
        ],
    },
    {
        'id': 68, 'name': 'COMMAND_SAFE_MODE', 'group': 'Сервер',
        'description': 'Обновить конфигурацию SafeMode (без параметров).',
        'supports_wait_response': True,
        'fields': [],
    },
    {
        'id': 69, 'name': 'COMMAND_SET_REALTORS_LINK', 'group': 'Сервер',
        'description': 'Ссылка для риэлторов.',
        'supports_wait_response': True,
        'fields': [_str('data_string_1', 'Значение', maxlen=256)],
    },
    {
        'id': 70, 'name': 'COMMAND_UPDATE_DATA_KEYS', 'group': 'Сервер',
        'description': 'Зарезервировано (DKV:InitVars).',
        'supports_wait_response': True,
        'fields': [_enum('data_1', 'Обновлять?', [
            {'value': 0, 'label': '0'},
            {'value': 1, 'label': '1'},
        ])],
    },

    # ── Стримеры / тиркейт ───────────────────────────────────────────
    {
        'id': 51, 'name': 'COMMAND_SET_VISIBLE_DYNAMIC_OBJ', 'group': 'Стример',
        'description': 'Streamer_SetVisibleItems(STREAMER_TYPE_OBJECT, value).',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Visible items')],
    },
    {
        'id': 52, 'name': 'COMMAND_SET_BLOCK_DYNAMIC_OBJ', 'group': 'Стример',
        'description': 'Заблокировать рендер dynamic object.',
        'supports_wait_response': True,
        'fields': [_enum('data_1', 'Блокировка', [
            {'value': 0, 'label': '0 — выкл'},
            {'value': 1, 'label': '1 — вкл'},
        ])],
    },
    {
        'id': 82, 'name': 'COMMAND_SET_BLOCK_MOVE_OBJECTS', 'group': 'Стример',
        'description': 'Заблокировать движение фуникулёров (PERSONAL_ANIM_FUNICULAR).',
        'supports_wait_response': True,
        'fields': [_enum('data_1', 'Блокировка', [
            {'value': 0, 'label': '0'},
            {'value': 1, 'label': '1'},
        ])],
    },
    {
        'id': 83, 'name': 'COMMAND_SET_UPDATE_PICKUP', 'group': 'Стример',
        'description': 'SetManualPickupUpdate(value).',
        'supports_wait_response': True,
        'fields': [_bool('data_1', 'Включить ручное обновление pickup')],
    },
    {
        'id': 84, 'name': 'COMMAND_SET_STREAMER_TICKRATE', 'group': 'Стример',
        'description': 'Streamer_SetTickRate(value). -1 — дефолт (100).',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Tick rate', hint='-1 = 100')],
    },
    {
        'id': 85, 'name': 'COMMAND_SET_STREAMER_UPDATE', 'group': 'Стример',
        'description': 'g_is_streamer_block_update.',
        'supports_wait_response': True,
        'fields': [_enum('data_1', 'Блокировать update', [
            {'value': 0, 'label': '0'},
            {'value': 1, 'label': '1'},
        ])],
    },
    {
        'id': 86, 'name': 'COMMAND_SET_STREAMER_MIN_TICK', 'group': 'Стример',
        'description': 'g_streamer_tick_rate_min.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Min tickrate')],
    },
    {
        'id': 87, 'name': 'COMMAND_SPAWN_DUMP', 'group': 'Стример',
        'description': 'Dump:SpawnContents() (без параметров).',
        'supports_wait_response': True,
        'fields': [],
    },
    {
        'id': 88, 'name': 'COMMAND_TOGGLE_STREAMER', 'group': 'Стример',
        'description': 'TogglePlayerAllDynamic* для всех онлайн-игроков.',
        'supports_wait_response': True,
        'fields': [
            _enum('data_1', 'Тип', [
                {'value': 0, 'label': '0 — Areas'},
                {'value': 1, 'label': '1 — RaceCPs'},
                {'value': 3, 'label': '3 — CPs'},
            ]),
            _bool('data_2', 'Включить'),
        ],
    },

    # ── Бизнес / дома / транспорт ───────────────────────────────────
    {
        'id': 2, 'name': 'COMMAND_BUSINESS_TO_AUCTION', 'group': 'Бизнес/Дома',
        'description': 'Выставить все бизнесы на аукцион государства.',
        'supports_wait_response': True,
        'fields': [],
    },
    {
        'id': 11, 'name': 'COMMAND_SET_OWNER_BUSINESS', 'group': 'Бизнес/Дома',
        'description': 'Сменить владельца бизнеса.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'SQL ID бизнеса'),
            _int('data_2', 'SQL ID нового владельца'),
        ],
    },
    {
        'id': 29, 'name': 'COMMAND_SET_BUSINESS', 'group': 'Бизнес/Дома',
        'description': 'Установить значение поля бизнеса (E_BUSINESS_STRUCT).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'SQL ID бизнеса'),
            _int('data_2', 'Индекс поля (E_BUSINESS_STRUCT)'),
            _int('data_3', 'Значение'),
        ],
    },
    {
        'id': 64, 'name': 'COMMAND_SET_OWNER_HOUSES', 'group': 'Бизнес/Дома',
        'description': 'Сменить владельца дома.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'SQL ID дома'),
            _int('data_2', 'SQL ID нового владельца'),
        ],
    },
    {
        'id': 94, 'name': 'COMMAND_EXTEND_RENT_HOUSE', 'group': 'Бизнес/Дома',
        'description': 'Продлить аренду дома (1..365 дней). Сбрасывает evict.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'SQL ID дома'),
            _int('data_2', 'Дней', minimum=1, maximum=365),
        ],
    },
    {
        'id': 95, 'name': 'COMMAND_EXTEND_RENT_BUSINESS', 'group': 'Бизнес/Дома',
        'description': 'Продлить аренду бизнеса (1..365 дней). Сбрасывает evict.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'SQL ID бизнеса'),
            _int('data_2', 'Дней', minimum=1, maximum=365),
        ],
    },
    {
        'id': 30, 'name': 'COMMAND_UNLOAD_VEHICLE', 'group': 'Бизнес/Дома',
        'description': 'Снять с парковки личный транспорт по SQL ID.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'SQL ID транспорта')],
    },
    {
        'id': 31, 'name': 'COMMAND_CHANGE_BOOKMAKER_STATUS', 'group': 'Бизнес/Дома',
        'description': 'Включить/выключить букмекерскую контору.',
        'supports_wait_response': True,
        'fields': [_enum('data_1', 'Статус', [
            {'value': 0, 'label': 'Выкл'},
            {'value': 1, 'label': 'Вкл'},
        ])],
    },
    {
        'id': 35, 'name': 'COMMAND_CHANGE_BOOKMAKER_COURSE', 'group': 'Бизнес/Дома',
        'description': 'Курс букмекера (1..100).',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Курс', minimum=1, maximum=100)],
    },
    {
        'id': 47, 'name': 'COMMAND_SET_BOOST_VEHICLE_SELL', 'group': 'Бизнес/Дома',
        'description': 'g_is_boost_vehicle_sell_status.',
        'supports_wait_response': True,
        'fields': [_enum('data_1', 'Статус', [
            {'value': 0, 'label': '0'},
            {'value': 1, 'label': '1'},
        ])],
    },

    # ── Бонусы / батлпасс / награды ─────────────────────────────────
    {
        'id': 1, 'name': 'COMMAND_SET_BONUSE', 'group': 'Бонусы',
        'description': 'Глобальный бонус X2/X3 на N дней.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'Дней', minimum=0),
            _enum('data_2', 'Тип бонуса', [
                {'value': 2, 'label': 'X2'},
                {'value': 3, 'label': 'X3'},
            ]),
        ],
    },
    {
        'id': 90, 'name': 'COMMAND_TOG_GLOBAL_BONUS', 'group': 'Бонусы',
        'description': 'XBonus:OnProcessExternalCommand(cmd, data_1, data_2, data_3).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'data_1'),
            _int('data_2', 'data_2'),
            _int('data_3', 'data_3 (секунды действия)'),
        ],
    },
    {
        'id': 91, 'name': 'COMMAND_TOG_GLOBAL_BONUS_GROUP', 'group': 'Бонусы',
        'description': 'XBonus:OnProcessExternalCommand(cmd, group, on, seconds).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'Группа'),
            _bool('data_2', 'Включить'),
            _int('data_3', 'Секунды'),
        ],
    },
    {
        'id': 23, 'name': 'COMMAND_CHANGE_BATTLE_PASS', 'group': 'Бонусы',
        'description': 'Цена премиум-баттлпасса.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Цена', minimum=0)],
    },
    {
        'id': 99, 'name': 'COMMAND_SET_BP_PLAYER', 'group': 'Бонусы',
        'description': 'BattlePass:OnExternalCommand (формат — на стороне сервера).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'data_1'),
            _int('data_2', 'data_2'),
            _int('data_3', 'data_3'),
            _str('data_string_1', 'data_string_1', required=False),
        ],
    },
    {
        'id': 36, 'name': 'COMMAND_GENERATE_NEW_DAILY_REW', 'group': 'Бонусы',
        'description': 'DailyReward:OnExternalCommand(36, data_1).',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'data_1', required=False)],
    },
    {
        'id': 38, 'name': 'COMMAND_DAILY_REW_SET_IS_ACTIVE', 'group': 'Бонусы',
        'description': 'DailyReward:OnExternalCommand(38, data_1).',
        'supports_wait_response': True,
        'fields': [_enum('data_1', 'Активна?', [
            {'value': 0, 'label': '0 — выкл'},
            {'value': 1, 'label': '1 — вкл'},
        ])],
    },
    {
        'id': 65, 'name': 'COMMAND_RELOAD_DAILY_REWARDS', 'group': 'Бонусы',
        'description': 'DailyReward:OnExternalCommand(65, data_1).',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'data_1', required=False)],
    },
    {
        'id': 42, 'name': 'COMMAND_UPDATE_HELLOWEEN_REWARD', 'group': 'Бонусы',
        'description': 'HelloweenReward:UpdateFromDB() (если фича включена).',
        'supports_wait_response': True,
        'fields': [],
    },

    # ── Магазин кейсов ──────────────────────────────────────────────
    {
        'id': 18, 'name': 'COMMAND_CHANGE_SETTINGS_CASES', 'group': 'Кейсы',
        'description': 'Cases:SetSettings(type, value).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'Тип настройки'),
            _int('data_2', 'Значение'),
        ],
    },
    {
        'id': 19, 'name': 'COMMAND_CHANGE_SETTINGS_CHANCE', 'group': 'Кейсы',
        'description': 'Шанс редкости в конкретном кейсе.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'ID кейса (rarity)'),
            _int('data_2', 'Индекс редкости'),
            _int('data_3', 'Шанс'),
        ],
    },
    {
        'id': 93, 'name': 'COMMAND_CASE_SHOP_RELOAD', 'group': 'Кейсы',
        'description': 'ConfigShopSettings:Reload().',
        'supports_wait_response': True,
        'fields': [],
    },

    # ── Команды / склады ───────────────────────────────────────────
    {
        'id': 8, 'name': 'COMMAND_RESET_TEAM_WAREHOUSE', 'group': 'Команды',
        'description': 'Обнулить склады команд (казначейству — 1 000 000).',
        'supports_wait_response': True,
        'fields': [],
    },
    {
        'id': 74, 'name': 'COMMAND_GIVE_WAREHOUSE', 'group': 'Команды',
        'description': 'Выдать деньги на склад команды.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'ID команды'),
            _int('data_2', 'Сумма'),
        ],
    },

    # ── Уведомления ─────────────────────────────────────────────────
    {
        'id': 26, 'name': 'COMMAND_UPDATE_NOTIFICATIONS', 'group': 'Уведомления',
        'description': 'ScreenNotification:OnExternalCommand(26, idx).',
        'supports_wait_response': True,
        'fields': [],
    },
    {
        'id': 27, 'name': 'COMMAND_NOTIFY_PLAYERS', 'group': 'Уведомления',
        'description': 'ScreenNotification:OnExternalCommand(27, idx).',
        'supports_wait_response': True,
        'fields': [],
    },

    # ── Грузоперевозки ─────────────────────────────────────────────
    {
        'id': 96, 'name': 'COMMAND_SET_TRUCK_DIST_BASE', 'group': 'Грузоперевозки',
        'description': 'g_trucker_distance_base (1000..10000).',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Значение', minimum=1000, maximum=10000)],
    },
    {
        'id': 97, 'name': 'COMMAND_SET_TRUCK_RATES', 'group': 'Грузоперевозки',
        'description': 'Параметры дальнобоя. Любое поле = 0 — не менять.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'Rate per unit (1..50)', required=False, minimum=0, maximum=50),
            _int('data_2', 'Oil rate per unit (1..50)', required=False, minimum=0, maximum=50),
            _int('data_3', 'Distance max bonus *10 (10..30)', required=False, minimum=0, maximum=30),
        ],
    },

    # ── Охота ───────────────────────────────────────────────────────
    {
        'id': 32, 'name': 'COMMAND_CHANGE_ANIMALS_MAX', 'group': 'Охота',
        'description': 'Максимум животных в лесу (день/ночь).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'ID леса', minimum=0),
            _int('data_2', 'Макс. животных', minimum=0),
            _enum('data_3', 'Ночь?', [
                {'value': 0, 'label': '0 — день'},
                {'value': 1, 'label': '1 — ночь'},
            ]),
        ],
    },
    {
        'id': 33, 'name': 'COMMAND_CHANGE_ANIMALS_MAX_TYPE', 'group': 'Охота',
        'description': 'Максимум животных по типу в лесу.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'ID леса', minimum=0),
            _int('data_2', 'Макс. животных', minimum=0),
            _int('data_3', 'Тип животного'),
        ],
    },
    {
        'id': 34, 'name': 'COMMAND_CHANGE_FLAY_DISABLE', 'group': 'Охота',
        'description': 'Отключить проверку свежевания.',
        'supports_wait_response': True,
        'fields': [_bool('data_1', 'Отключить')],
    },

    # ── Транспорт / прочие ──────────────────────────────────────────
    {
        'id': 21, 'name': 'COMMAND_DISABLE_STROBOSCOPES', 'group': 'Транспорт',
        'description': 'g_strobes_disable.',
        'supports_wait_response': True,
        'fields': [_enum('data_1', 'Значение', [
            {'value': 0, 'label': '0'},
            {'value': 1, 'label': '1'},
        ])],
    },
    {
        'id': 22, 'name': 'COMMAND_DISABLE_CAR_SIREN', 'group': 'Транспорт',
        'description': 'Переключить g_car_siren_disable (без параметров).',
        'supports_wait_response': True,
        'fields': [],
    },
    {
        'id': 24, 'name': 'COMMAND_CHANGE_MOVE_OBJECTS', 'group': 'Транспорт',
        'description': 'g_is_move_objects.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Значение')],
    },
    {
        'id': 25, 'name': 'COMMAND_CHANGE_FUEL_DATA', 'group': 'Транспорт',
        'description': 'FuelStation:ChangeFuelData(type, order_cost, min_price, max_price).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'Тип топлива'),
            _int('data_2', 'Стоимость заказа'),
            _int('data_3', 'Min цена'),
            _int('data_4', 'Max цена'),
        ],
    },
    {
        'id': 28, 'name': 'COMMAND_RELOAD_ITEMS', 'group': 'Транспорт',
        'description': 'Items:Reload(owner_type, owner_idx).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'Owner type'),
            _int('data_2', 'Owner idx'),
        ],
    },
    {
        'id': 78, 'name': 'COMMAND_USING_ITEMS_FIX_STATUS', 'group': 'Транспорт',
        'description': 'g_items_using_slot_status.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Значение')],
    },

    # ── GPS / зоны ──────────────────────────────────────────────────
    {
        'id': 37, 'name': 'COMMAND_DISABLE_ALL_GPS_ROUTE', 'group': 'GPS/Зоны',
        'description': 'GPS:DisableAllRoutes() (без параметров).',
        'supports_wait_response': True,
        'fields': [],
    },
    {
        'id': 66, 'name': 'COMMAND_SET_GZ_PROPERTIES', 'group': 'GPS/Зоны',
        'description': 'Настройки зелёной зоны (data_string_1 = JSON).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'SQL ID зоны'),
            _str('data_string_1', 'JSON', maxlen=512),
        ],
    },

    # ── Тренировка / семьи ──────────────────────────────────────────
    {
        'id': 45, 'name': 'COMMAND_SET_START_STUDY_STATE', 'group': 'Тренировка',
        'description': 'StartStudy:ProcessExternalCommand(cmd, idx).',
        'supports_wait_response': True,
        'fields': [],
    },
    {
        'id': 46, 'name': 'COMMAND_SET_SALARY_SETTINGS', 'group': 'Тренировка',
        'description': 'g_salary_jobs_settings[setting_id][MIN_SALARY] = value.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'Setting ID'),
            _int('data_2', 'Значение'),
        ],
    },
    {
        'id': 77, 'name': 'COMMAND_FML_UPLOAD_LOGO', 'group': 'Семьи',
        'description': 'FamilyTablet:UploadLogo(org_id, account_id, filename, status).',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'Organization ID'),
            _int('data_2', 'Status'),
            _int('data_3', 'Account ID'),
            _str('data_string_1', 'Filename', maxlen=256),
        ],
    },
    {
        'id': 79, 'name': 'COMMAND_FML_ADD_POINTS', 'group': 'Семьи',
        'description': 'Family:AddUpgradePoints или прямой SQL.',
        'supports_wait_response': True,
        'fields': [
            _int('data_1', 'Family ID'),
            _int('data_2', 'Очки'),
            _bool('data_3', 'Уведомление'),
        ],
    },
    {
        'id': 80, 'name': 'COMMAND_FML_GR_UPDATE', 'group': 'Семьи',
        'description': 'GamesRotator:UpdateListing() (если data_1 != 0).',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Триггер')],
    },

    # ── События ─────────────────────────────────────────────────────
    {
        'id': 53, 'name': 'COMMAND_SET_BLACKJACK_DISABLED', 'group': 'События',
        'description': 'g_is_blackjack_disabled.',
        'supports_wait_response': True,
        'fields': [_enum('data_1', 'Disabled', [
            {'value': 0, 'label': '0 — вкл'},
            {'value': 1, 'label': '1 — выкл'},
        ])],
    },
    {
        'id': 54, 'name': 'COMMAND_CHANGE_CYBERWEEN_STATE', 'group': 'События',
        'description': 'CyberWeen:ProcessExternalCMD(cmd, idx).',
        'supports_wait_response': True,
        'fields': [],
    },
    {
        'id': 56, 'name': 'COMMAND_HOT_POTATO_DISABLED', 'group': 'События',
        'description': 'g_is_hot_potato_disabled (фича HOT_POTATO).',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Значение')],
    },
    {
        'id': 57, 'name': 'COMMAND_HOT_CYBER_CHANGE_STATUS', 'group': 'События',
        'description': 'CyberWeen StartHacking / Stop в зависимости от data_1.',
        'supports_wait_response': True,
        'fields': [_enum('data_1', 'Статус', [
            {'value': 0, 'label': '0 — Stop'},
            {'value': 1, 'label': '1 — Start'},
        ])],
    },
    {
        'id': 58, 'name': 'COMMAND_ELF_RESCUE_ACCESS_GIFTS', 'group': 'События',
        'description': 'ELF_RESCUE: E_ERGV_TYPE_GIFTS = value.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Значение')],
    },
    {
        'id': 59, 'name': 'COMMAND_ELF_RESCUE_MAX_STARS', 'group': 'События',
        'description': 'ELF_RESCUE: E_ERGV_TYPE_MAX_PROGRESS = value.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Значение')],
    },
    {
        'id': 60, 'name': 'COMMAND_ELF_RESCUE_PROGRESS', 'group': 'События',
        'description': 'ELF_RESCUE: E_ERGV_TYPE_PROGRESS = value.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Значение')],
    },
    {
        'id': 61, 'name': 'COMMAND_ELF_RESCUE_STATUS', 'group': 'События',
        'description': 'ELF_RESCUE: E_ERGV_TYPE_STATUS = value.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Значение')],
    },
    {
        'id': 71, 'name': 'COMMAND_STATUS_GAMES_ROTATOR', 'group': 'События',
        'description': 'SetGamesRotatorInfo(E_GRI_IS_ENABLED, bool(value)).',
        'supports_wait_response': True,
        'fields': [_bool('data_1', 'Включён')],
    },
    {
        'id': 72, 'name': 'COMMAND_G_ROTATOR_GIVE_REWARDS', 'group': 'События',
        'description': 'OnGamesRotatorExecuteRewardsEx(value), value > 0.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Значение', minimum=1)],
    },
    {
        'id': 73, 'name': 'COMMAND_G_ROTATOR_RECV_WIANNERS', 'group': 'События',
        'description': 'OnGamesRotatorRecvWinners().',
        'supports_wait_response': True,
        'fields': [_enum('data_1', 'Триггер', [
            {'value': 0, 'label': '0'},
            {'value': 1, 'label': '1'},
        ])],
    },
    {
        'id': 92, 'name': 'COMMAND_G_ROTATOR_GIVE_RWDRLST', 'group': 'События',
        'description': 'OnGamesRotatorExecuteRwrdsLsme(value), value > 0.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Значение', minimum=1)],
    },
    {
        'id': 48, 'name': 'COMMAND_SET_TRADE_ITEM', 'group': 'События',
        'description': 'g_is_trade_items_status.',
        'supports_wait_response': True,
        'fields': [_int('data_1', 'Значение')],
    },

    # ── PayDay ──────────────────────────────────────────────────────
    {
        'id': 75, 'name': 'COMMAND_GIVE_PAYDAY', 'group': 'Прочее',
        'description': 'OnPayDay(.is_debug = true) (без параметров).',
        'supports_wait_response': True,
        'fields': [],
    },
    {
        'id': 89, 'name': 'COMMAND_ACT_TRK_CONFIG_RELOAD', 'group': 'Прочее',
        'description': 'ActivityTracker:OnExternalCommand(89).',
        'supports_wait_response': True,
        'fields': [],
    },
]


def list_commands() -> list[dict[str, Any]]:
    """Полный каталог — то что отдаём фронту."""
    return CATALOG


def find_command(command_id: int) -> dict[str, Any] | None:
    for c in CATALOG:
        if c['id'] == command_id:
            return c
    return None


# Все валидные ключи полей
ALLOWED_DATA_KEYS = {'data_1', 'data_2', 'data_3', 'data_4'}
ALLOWED_STRING_KEYS = {'data_string_1'}

# Названия состояний (под колонку `state`)
STATE_NAMES = {
    1: 'WAIT_RESPONSE',
    2: 'OK',
    3: 'BAD_REQUEST',
    4: 'NOT_IMPLEMENTED',
    5: 'NOT_FOUND',
    6: 'SERVER_ERROR',
}
