/**
 * JSON 배달 주문 데이터를 ESC/POS 영수증 포맷으로 변환
 *
 * 58mm 용지 기준 설계 (32자 폭):
 * - 영문/숫자: 1자 = 1폭
 * - 한글: 1자 = 2폭 (UTF-8 멀티바이트 문자)
 * - 실제 가용 폭: 한글 16자 또는 영문 32자
 *
 * node-thermal-printer의 제약사항:
 * 1. 한글 직접 출력 불가 - ESC/POS 표준 문자셋(PC437)은 영문/숫자/특수문자만 지원
 * 2. 해결책: printer.printImage() 또는 외부 폰트 라이브러리 사용
 * 3. 현재는 한글을 그대로 전달 - 프린터 펌웨어가 한글 코드페이지 지원 시 출력됨
 *    (대부분의 국내 판매 영수증 프린터는 KS X 1001 또는 EUC-KR 지원)
 */

/**
 * 텍스트 정렬 헬퍼 (32자 폭 기준)
 *
 * @param {string} text - 출력 텍스트
 * @param {string} align - 정렬 방식 ('left' | 'center' | 'right')
 * @returns {string} 정렬된 텍스트
 *
 * 한글 폭 계산 이슈:
 * - 한글은 2바이트(UTF-8 기준 3바이트)지만 프린터 폰트에서 2폭 차지
 * - 정확한 정렬을 위해 한글 문자 개수를 별도 계산
 * - 예: "과일맛집" = 4글자 × 2폭 = 8폭
 */
function alignText(text, align = 'left', width = 32) {
  // 한글 문자 개수 계산 (유니코드 범위: AC00-D7A3)
  const koreanCount = (text.match(/[\uAC00-\uD7A3]/g) || []).length;
  // 실제 폭 = 전체 길이 + 한글 개수 (한글은 2폭이므로 +1)
  const actualWidth = text.length + koreanCount;

  if (actualWidth >= width) return text;

  const padding = width - actualWidth;

  if (align === 'center') {
    const leftPad = Math.floor(padding / 2);
    const rightPad = padding - leftPad;
    return ' '.repeat(leftPad) + text + ' '.repeat(rightPad);
  } else if (align === 'right') {
    return ' '.repeat(padding) + text;
  } else {
    return text + ' '.repeat(padding);
  }
}

/**
 * 금액 포맷팅 (천 단위 콤마 + 우측 정렬)
 *
 * @param {number} amount - 금액
 * @returns {string} 포맷된 금액 문자열
 *
 * 예: 15900 → "15,900원"
 */
function formatAmount(amount) {
  return amount.toLocaleString('ko-KR') + '원';
}

/**
 * 우측 정렬된 금액 문자열 생성
 *
 * @param {number} amount - 금액
 * @param {number} width - 전체 폭 (기본 15자)
 * @returns {string} 정렬된 문자열
 *
 * 사용처: 상품 금액, 합계 등 숫자 칼럼
 * 예: "     15,900원" (15자 우측 정렬)
 */
function formatPrice(amount, width = 15) {
  const formatted = formatAmount(amount);
  // 금액 문자열은 순수 ASCII이므로 일반 길이 계산 사용
  const padding = Math.max(0, width - formatted.length);
  return ' '.repeat(padding) + formatted;
}

/**
 * 상품명과 금액을 좌우 정렬하여 한 줄에 배치
 *
 * @param {string} label - 좌측 레이블
 * @param {string} value - 우측 값
 * @returns {string} 정렬된 행
 *
 * 레이아웃:
 * "상품합계:            13,000원" (32자)
 * - label: 좌측 정렬
 * - value: 우측 정렬
 * - 중간 공백으로 채움
 */
function formatRow(label, value, width = 32) {
  const koreanCount = (label.match(/[\uAC00-\uD7A3]/g) || []).length;
  const labelWidth = label.length + koreanCount;
  const valueKoreanCount = (value.match(/[\uAC00-\uD7A3]/g) || []).length;
  const valueWidth = value.length + valueKoreanCount;

  const padding = Math.max(0, width - labelWidth - valueWidth);
  return label + ' '.repeat(padding) + value;
}

/**
 * 배달 주문 데이터를 영수증 ESC/POS 명령으로 변환
 *
 * @param {ThermalPrinter} printer - 프린터 인스턴스
 * @param {Object} data - 주문 데이터
 *
 * ESC/POS 명령 설명:
 * - alignCenter(): 중앙 정렬 모드 활성화
 * - bold(true): 볼드체 ON (헤더, 합계 강조용)
 * - drawLine(): lineCharacter("=")를 32번 반복하여 구분선 출력
 * - newLine(): LF(Line Feed, 0x0A) 전송 - 용지 한 줄 이동
 * - cut(): 용지 절단 명령 (ESC i, 프린터가 오토커터 지원 시)
 *
 * 영수증 레이아웃:
 * 1. 헤더 (상호명) - 중앙 정렬, 볼드
 * 2. 주문 정보 - 주문번호, 일시, 배달예정
 * 3. 고객 정보 - 이름, 전화번호
 * 4. 상품 목록 - 상품명, 수량, 단가, 금액 (테이블 형식)
 * 5. 합계 - 상품합계, 배달비, 총합계
 * 6. 배달 주소 - 주소1, 주소2
 */
export function buildReceipt(printer, data) {
  const {
    orderId,
    displayCode,
    paidAt,
    deliveryHour,
    deliveryMinute,
    buyerName,
    phone,
    items,
    totalProductAmount,
    deliveryFee,
    distanceKm,
    address1,
    address2,
    scheduledDeliveryHour,
    scheduledDeliveryMinute
  } = data;

  const isScheduled = scheduledDeliveryHour != null;

  // 날짜 포맷: "2026-02-12 02:08:03"
  const d = new Date(paidAt);
  const orderDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

  // 배달예정 시각: "15:10"
  const deliveryTime = `${String(deliveryHour).padStart(2, '0')}:${String(deliveryMinute).padStart(2, '0')}`;

  // 총 결제금액 = 상품합계 + 배달비
  const totalAmount = totalProductAmount + deliveryFee;

  // 예약배달 시각 (헤더 + 주문정보에서 공용)
  const scheduledTime = isScheduled
    ? `${String(scheduledDeliveryHour).padStart(2, '0')}:${String(scheduledDeliveryMinute ?? 0).padStart(2, '0')}`
    : null;

  // ========== 헤더 ==========
  // setTextQuadArea: 가로+세로 2배 (4배 면적) → 16자 폭 기준
  // "과일맛집1995" = 한글4자(8폭) + 숫자4자(4폭) = 12폭 → 16자 폭 내 중앙 정렬
  printer.alignCenter();
  printer.drawLine();
  printer.setTextQuadArea();
  printer.bold(true);
  printer.println('과일맛집1995');
  printer.bold(false);
  printer.setTextNormal();
  printer.alignLeft();
  printer.drawLine();

  // ========== 예약배달 표시 ==========
  if (isScheduled) {
    printer.alignCenter();
    printer.setTextDoubleHeight();
    printer.bold(true);
    printer.println(`** ${scheduledTime} 예약배달 **`);
    printer.bold(false);
    printer.setTextNormal();
    printer.alignLeft();
  }

  // ========== 주문 정보 ==========
  const orderLabel = displayCode || `#${orderId}`;
  printer.println('[주문정보]');
  printer.setTextDoubleHeight();
  printer.bold(true);
  printer.println(orderLabel);
  printer.bold(false);
  printer.setTextNormal();
  printer.println(`주문일시: ${orderDate}`);
  if (isScheduled) {
    printer.bold(true);
    printer.println(`도착예정: ${scheduledTime}`);
    printer.bold(false);
  } else if (deliveryHour != null && deliveryMinute != null) {
    printer.bold(true);
    printer.println(`배달예정: ${deliveryTime}`);
    printer.bold(false);
  }
  printer.println('--------------------------------');

  // ========== 고객 정보 ==========
  printer.println('[고객정보]');
  printer.setTextDoubleHeight();
  printer.bold(true);
  printer.println(`${buyerName} / ${phone}`);
  printer.bold(false);
  printer.setTextNormal();
  printer.newLine();
  // ========== 배달 주소 ==========
  printer.println('[배달주소]');
  printer.setTextDoubleHeight();
  printer.bold(true);
  printer.println(address1);
  if (address2) {
    printer.println(address2);
  }
  printer.bold(false);
  printer.setTextNormal();
  printer.println('--------------------------------');

  // ========== 상품 목록 ==========
  // 헤더 우측정렬 기준: 상품명(~14) 수량(~17) 가격(~24) 총합(~32)
  printer.println('상품명       수량   가격    총합');
  items.forEach(item => {
    const { productName, quantity, amount } = item;
    const unitPrice = amount / quantity;

    // 상품명: 최대 14폭 (한글 7자), 넘으면 자름
    const nameMaxWidth = 14;
    const nameKoreanCount = (productName.match(/[\uAC00-\uD7A3]/g) || []).length;
    const nameActualWidth = productName.length + nameKoreanCount;
    const truncatedName = nameActualWidth > nameMaxWidth
      ? productName.substring(0, 7) // 한글 7자 기준 자름
      : productName;

    // 상품명 좌측 정렬 (14자 폭)
    const namePadding = 14 - (truncatedName.length + (truncatedName.match(/[\uAC00-\uD7A3]/g) || []).length);
    const nameField = truncatedName + ' '.repeat(Math.max(0, namePadding));

    // 수량 우측 정렬 (3자 폭)
    const qtyField = String(quantity).padStart(3, ' ');

    // 단가 우측 정렬 (7자 폭)
    const unitField = String(unitPrice.toLocaleString('ko-KR')).padStart(7, ' ');

    // 금액 우측 정렬 (8자 폭)
    const amtField = String(amount.toLocaleString('ko-KR')).padStart(8, ' ');

    printer.println(`${nameField}${qtyField}${unitField}${amtField}`);
  });

  printer.println('--------------------------------');

  // ========== 합계 ==========
  printer.bold(true);
  printer.println(formatRow('상품합계:', formatAmount(totalProductAmount)));
  printer.println(formatRow(`배달비(${distanceKm}km):`, formatAmount(deliveryFee)));
  printer.bold(false);
  printer.drawLine();

  // 총합계 강조 (4배 면적 + 볼드)
  // setTextQuadArea 시 16자 폭 기준으로 정렬
  printer.alignCenter();
  printer.setTextQuadArea();
  printer.bold(true);
  printer.println(formatRow('합계:', formatAmount(totalAmount), 16));
  printer.bold(false);
  printer.setTextNormal();
  printer.alignLeft();
  printer.drawLine();

  // 용지 여백 추가 (절단 시 내용 잘림 방지)
  printer.newLine();
  printer.newLine();
  printer.newLine();

  // 용지 절단 (오토커터 지원 프린터만 동작)
  printer.cut();
}
