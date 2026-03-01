import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// Local dictionaries for the Core UI elements
const resources = {
    en: {
        translation: {
            nav: {
                home: "Home",
                itinerary: "Itinerary",
                wallet: "Wallet",
                photos: "Photos",
                crew: "Crew"
            },
            header: {
                online: "Online",
                offline: "Offline",
                syncing: "Syncing..."
            },
            settings: {
                general: "GENERAL",
                language: "Language",
                changeAvatar: "Change Avatar",
                remove: "Remove",
                username: "Username",
                email: "Email",
                phone: "Phone",
                saveProfile: "Save Profile",
                saved: "Saved!",
                reset: "Reset",
                synced: "Synced",
                notifications: "NOTIFICATIONS",
                emergencyPush: "Emergency Push",
                pushDescActive: "Alerts will ring even in bg",
                pushDescInactive: "Get loud alerts when members use SOS, even in bg.",
                enable: "Enable",
                active: "Active",
                transactionHistory: "TRANSACTION HISTORY",
                exportCsv: "Export All Data (CSV)"
            },
            sos: {
                alertTitle: "EMERGENCY ALERT!",
                alertBody: "A member of your group just triggered the Panic Button!",
                openMap: "Open Live Map",
                closeAlert: "Close Alert",
                activateTitle: "Activate SOS?",
                activateDesc: "Your location will be shared in real time and an alert will be sent to all your travel companions.",
                deactivateTitle: "Deactivate SOS?",
                deactivateDesc: "Your location will stop being shared and the emergency will be marked as resolved.",
                btnActivate: "Activate SOS",
                btnDeactivate: "Deactivate SOS",
                btnCancel: "Cancel"
            }
        }
    },
    pt: {
        translation: {
            nav: {
                home: "Início",
                itinerary: "Roteiro",
                wallet: "Carteira",
                photos: "Fotos",
                crew: "Grupo"
            },
            header: {
                online: "Online",
                offline: "Offline",
                syncing: "Sincronizando..."
            },
            settings: {
                general: "GERAL",
                language: "Idioma",
                changeAvatar: "Mudar Foto",
                remove: "Remover",
                username: "Nome",
                email: "E-mail",
                phone: "Telefone",
                saveProfile: "Salvar Perfil",
                saved: "Salvo!",
                reset: "Redefinir",
                synced: "Sincronizado",
                notifications: "NOTIFICAÇÕES",
                emergencyPush: "Push de Emergência",
                pushDescActive: "Alertas tocam mesmo fechado",
                pushDescInactive: "Receba alertas altos de SOS mesmo com o app fechado.",
                enable: "Ativar",
                active: "Ativo",
                transactionHistory: "HISTÓRICO",
                exportCsv: "Exportar Dados (CSV)"
            },
            sos: {
                alertTitle: "ALERTA DE EMERGÊNCIA!",
                alertBody: "Um membro do seu grupo acabou de acionar o botão de Pânico!",
                openMap: "Abrir Mapa ao Vivo",
                closeAlert: "Fechar Aviso",
                activateTitle: "Ativar botão de Emergência?",
                activateDesc: "Sua localização será compartilhada em tempo real e um aviso será enviado para todo o grupo.",
                deactivateTitle: "Desativar SOS?",
                deactivateDesc: "Sua localização vai parar de ser enviada e o alerta será marcado como resolvido.",
                btnActivate: "Ativar SOS",
                btnDeactivate: "Desativar SOS",
                btnCancel: "Cancelar"
            }
        }
    },
    es: {
        translation: {
            nav: {
                home: "Inicio",
                itinerary: "Itinerario",
                wallet: "Billetera",
                photos: "Fotos",
                crew: "Grupo"
            },
            header: {
                online: "En línea",
                offline: "Desconectado",
                syncing: "Sincronizando..."
            },
            settings: {
                general: "GENERAL",
                language: "Idioma",
                changeAvatar: "Cambiar Foto",
                remove: "Quitar",
                username: "Usuario",
                email: "Correo",
                phone: "Teléfono",
                saveProfile: "Guardar",
                saved: "¡Guardado!",
                reset: "Restablecer",
                synced: "Sincronizado",
                notifications: "NOTIFICACIONES",
                emergencyPush: "Alertas de Emergencia",
                pushDescActive: "Sonarán aunque esté cerrado",
                pushDescInactive: "Recibe alarmas fuertes si hay SOS, incluso de fondo.",
                enable: "Activar",
                active: "Activo",
                transactionHistory: "HISTORIAL DE TRANSACCIONES",
                exportCsv: "Exportar Datos (CSV)"
            },
            sos: {
                alertTitle: "¡ALERTA DE EMERGENCIA!",
                alertBody: "¡Un miembro de tu grupo acaba de activar el botón de Pánico!",
                openMap: "Abrir Mapa en Vivo",
                closeAlert: "Cerrar Alerta",
                activateTitle: "¿Activar SOS?",
                activateDesc: "Tu ubicación se compartirá en tiempo real y todos serán notificados.",
                deactivateTitle: "¿Desactivar SOS?",
                deactivateDesc: "Tu ubicación dejará de ser compartida y la emergencia será resuelta.",
                btnActivate: "Activar SOS",
                btnDeactivate: "Desactivar SOS",
                btnCancel: "Cancelar"
            }
        }
    },
    ru: {
        translation: {
            nav: {
                home: "Главная",
                itinerary: "Маршрут",
                wallet: "Кошелек",
                photos: "Фото",
                crew: "Группа"
            },
            header: {
                online: "В сети",
                offline: "Не в сети",
                syncing: "Синхронизация..."
            },
            settings: {
                general: "ОБЩИЕ",
                language: "Язык",
                changeAvatar: "Сменить Аватар",
                remove: "Удалить",
                username: "Имя",
                email: "Почта",
                phone: "Телефон",
                saveProfile: "Сохранить",
                saved: "Сохранено!",
                reset: "Сброс",
                synced: "Синхронизировано",
                notifications: "УВЕДОМЛЕНИЯ",
                emergencyPush: "Экстренные Уведомления",
                pushDescActive: "Звучат даже в фоне",
                pushDescInactive: "Громкие сигналы SOS даже если приложение закрыто.",
                enable: "Включить",
                active: "Активно",
                transactionHistory: "ИСТОРИЯ ОПЕРАЦИЙ",
                exportCsv: "Скачать Данные (CSV)"
            },
            sos: {
                alertTitle: "ТРЕВОГА!",
                alertBody: "Член вашей группы нажал кнопку SOS!",
                openMap: "Открыть Карту",
                closeAlert: "Закрыть Тревогу",
                activateTitle: "Активировать SOS?",
                activateDesc: "Ваше местоположение будет передаваться в реальном времени всей группы.",
                deactivateTitle: "Отключить SOS?",
                deactivateDesc: "Передача локации прекратится. Тревога будет отменена.",
                btnActivate: "Включить SOS",
                btnDeactivate: "Отключить SOS",
                btnCancel: "Отмена"
            }
        }
    },
    zh: {
        translation: {
            nav: {
                home: "首页",
                itinerary: "行程",
                wallet: "钱包",
                photos: "相册",
                crew: "群组"
            },
            header: {
                online: "在线",
                offline: "离线",
                syncing: "同步中..."
            },
            settings: {
                general: "常规",
                language: "语言",
                changeAvatar: "更改头像",
                remove: "移除",
                username: "用户名",
                email: "电子邮件",
                phone: "电话",
                saveProfile: "保存资料",
                saved: "已保存！",
                reset: "重置",
                synced: "已同步",
                notifications: "通知",
                emergencyPush: "紧急推送",
                pushDescActive: "后台也将发出警报",
                pushDescInactive: "即使关闭应用程序，也能获得 SOS 重大警报。",
                enable: "启用",
                active: "已激活",
                transactionHistory: "交易历史",
                exportCsv: "导出全部数据 (CSV)"
            },
            sos: {
                alertTitle: "紧急警报！",
                alertBody: "您团队中的一名成员触发了恐慌按钮！",
                openMap: "打开实时地图",
                closeAlert: "关闭警报",
                activateTitle: "激活 SOS？",
                activateDesc: "您的位置将实时共享并发送给所有同伴。",
                deactivateTitle: "停用 SOS？",
                deactivateDesc: "您的位置将停止共享并标记为已解决。",
                btnActivate: "激活 SOS",
                btnDeactivate: "停用 SOS",
                btnCancel: "取消"
            }
        }
    }
};

i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
        resources,
        fallbackLng: 'en',
        interpolation: {
            escapeValue: false
        }
    });

export default i18n;
