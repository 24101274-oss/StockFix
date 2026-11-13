import type { Sale, Settings } from '../../shared/types';
import { dateTime, locations, paymentNames, soles } from '../lib/format';

export const documentNames = { ticket: 'Ticket', boleta: 'Boleta', factura: 'Factura' };

export default function Receipt({ sale, settings }: { sale: Sale; settings: Settings }) {
  return (
    <article className="receipt-print mx-auto w-full max-w-[80mm] bg-white px-5 py-6 text-[12px] leading-relaxed text-black" aria-label={`Documento de prueba ${sale.number}`}>
      <header className="text-center">
        <h2 className="text-lg font-extrabold">{settings.businessName}</h2>
        <p>RUC: {settings.ruc}</p>
        {settings.address ? <p>{settings.address}</p> : null}
        <div className="my-4 border-2 border-black p-2 text-[11px] font-bold leading-tight">
          DOCUMENTO DE PRUEBA<br />SIN VALIDEZ TRIBUTARIA
        </div>
        <h3 className="text-sm font-bold">{documentNames[sale.documentType]} de prueba</h3>
        <p className="font-semibold">N.º interno {sale.number}</p>
        <p>{dateTime(sale.createdAt)}</p>
      </header>
      <div className="my-4 border-y border-dashed border-black py-3">
        <p><strong>Cliente:</strong> {sale.customer?.name ?? 'Consumidor final'}</p>
        {sale.customer?.document ? <p>{sale.customer.documentType}: {sale.customer.document}</p> : null}
        {sale.customer?.address ? <p>Dirección: {sale.customer.address}</p> : null}
        <p>Atendido por: {sale.userName}</p>
      </div>
      <table className="w-full text-left">
        <caption className="sr-only">Productos de la venta</caption>
        <thead className="border-b border-dashed border-black">
          <tr><th className="pb-2 font-semibold">Producto / cantidad</th><th className="pb-2 text-right font-semibold">Importe</th></tr>
        </thead>
        <tbody>
          {sale.items.map((item, index) => (
            <tr key={`${item.productId}-${item.presentationId}-${item.location}-${index}`}>
              <td className="max-w-[175px] py-2 pr-2 align-top">
                <p className="font-semibold break-words">{item.name}</p>
                <p>{item.quantity} × {item.presentationLabel} · {soles(item.unitPriceCents)}</p>
                <p className="text-[10px]">Origen: {locations[item.location]}</p>
              </td>
              <td className="py-2 text-right align-top whitespace-nowrap">{soles(item.totalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 space-y-1 border-t border-dashed border-black pt-3">
        <p className="flex justify-between text-base font-bold"><span>TOTAL</span><span>{soles(sale.totalCents)}</span></p>
        <p className="flex justify-between"><span>Pago</span><span>{paymentNames[sale.paymentMethod]}</span></p>
        {sale.paymentMethod === 'efectivo' ? <>
          <p className="flex justify-between"><span>Recibido</span><span>{soles(sale.paidCents)}</span></p>
          <p className="flex justify-between"><span>Vuelto</span><span>{soles(sale.changeCents)}</span></p>
        </> : null}
      </div>
      <footer className="mt-5 border-t border-dashed border-black pt-3 text-center text-[10px]">
        <p className="font-bold">No enviado a NubeFact ni a SUNAT.</p>
        <p>Precios finales. Configuración tributaria pendiente.</p>
        <p>Este número pertenece únicamente al registro interno de pruebas.</p>
      </footer>
    </article>
  );
}
